use crate::analysis::ddsa_lib::common::DDSAJsRuntimeError;
use crate::analysis::ddsa_lib::runtime::ExecutionResult;
use crate::analysis::ddsa_lib::JsRuntime;
use crate::analysis::generated_content::is_generated_file;
use crate::analysis::tree_sitter::get_tree;
use crate::arguments::ArgumentProvider;
use crate::model::analysis::{
    FileIgnoreBehavior, LinesToIgnore, ERROR_RULE_EXECUTION, ERROR_RULE_TIMEOUT,
};
use crate::model::common::Language;
use crate::model::config_file::split_path;
use crate::model::rule::{RuleInternal, RuleResult};
use common::analysis_options::AnalysisOptions;
use std::borrow::Borrow;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The duration an individual execution of `v8` may run before it will be forcefully halted.
const JAVASCRIPT_EXECUTION_TIMEOUT: Duration = Duration::from_millis(5000);

thread_local! {
    /// A thread-local `JsRuntime`
    pub static DEFAULT_JS_RUNTIME: std::cell::RefCell<JsRuntime> = {
        let runtime = JsRuntime::try_new().expect("runtime should have all data required to init");
        std::cell::RefCell::new(runtime)
    };
}

/// Split the code and extract all the logic that reports to lines to ignore.
/// If a no-dd-sa statement occurs on the first line, it applies to the whole file.
/// Otherwise, it only applies to the line below.
fn get_lines_to_ignore(code: &str, language: &Language) -> LinesToIgnore {
    let mut lines_to_ignore_for_all_rules = vec![];
    let mut lines_to_ignore_per_rules: HashMap<u32, Vec<String>> = HashMap::new();

    let mut line_number = 1u32;
    let disabling_patterns = match language {
        Language::Python
        | Language::Starlark
        | Language::Dockerfile
        | Language::Ruby
        | Language::Terraform
        | Language::Yaml
        | Language::Bash => {
            vec!["#no-dd-sa", "#datadog-disable"]
        }
        Language::JavaScript | Language::TypeScript => {
            vec![
                "//no-dd-sa",
                "/*no-dd-sa",
                "//datadog-disable",
                "/*datadog-disable",
            ]
        }
        Language::Go
        | Language::Rust
        | Language::Csharp
        | Language::Java
        | Language::Kotlin
        | Language::Swift => {
            vec!["//no-dd-sa", "//datadog-disable"]
        }
        Language::Json => {
            vec!["impossiblestringtoreach"]
        }
        Language::PHP => {
            vec![
                "//no-dd-sa",
                "/*no-dd-sa",
                "//datadog-disable",
                "/*datadog-disable",
                "#no-dd-sa",
                "#datadog-disable",
            ]
        }
    };
    let mut ignore_file_all_rules: bool = false;
    let mut rules_to_ignore: Vec<String> = vec![];
    for line in code.lines() {
        let line_without_whitespaces: String =
            line.chars().filter(|c| !c.is_whitespace()).collect();
        for p in &disabling_patterns {
            if line_without_whitespaces.contains(p) {
                // get the rulesets/rules being referenced on the line
                let parts: Vec<String> = line
                    .to_string()
                    .replace("//", "")
                    .replace("/*", "")
                    .replace("*/", "")
                    .replace('#', "")
                    .replace("no-dd-sa", "")
                    .replace("datadog-disable", "")
                    .replace(':', "")
                    .replace(',', " ")
                    .split_whitespace()
                    .filter(|e| e.contains('/'))
                    .map(|e| e.to_string())
                    .collect();

                // no ruleset/rules specified, we just ignore everything
                if parts.is_empty() {
                    if line_number == 1 {
                        ignore_file_all_rules = true;
                    } else {
                        lines_to_ignore_for_all_rules.push(line_number + 1);
                    }
                } else if line_number == 1 {
                    rules_to_ignore.extend(parts.clone());
                } else {
                    lines_to_ignore_per_rules.insert(line_number + 1, parts.clone());
                }
            }
        }
        line_number += 1;
    }

    let ignore_file = if ignore_file_all_rules {
        FileIgnoreBehavior::AllRules
    } else {
        FileIgnoreBehavior::SomeRules(rules_to_ignore)
    };

    LinesToIgnore {
        lines_to_ignore: lines_to_ignore_for_all_rules,
        lines_to_ignore_per_rule: lines_to_ignore_per_rules,
        ignore_file,
    }
}

// main function
// 1. Build the context (tree-sitter tree, etc)
// 2. Run the tree-sitter query and build the object that hold the match
// 3. Execute the rule
// 4. Collect results and errors
pub fn analyze<I>(
    language: &Language,
    rules: I,
    filename: &Arc<str>,
    code: &Arc<str>,
    argument_provider: &ArgumentProvider,
    analysis_option: &AnalysisOptions,
) -> Vec<RuleResult>
where
    I: IntoIterator,
    I::Item: Borrow<RuleInternal>,
{
    DEFAULT_JS_RUNTIME.with_borrow_mut(|runtime| {
        analyze_with(
            runtime,
            language,
            rules,
            filename,
            code,
            argument_provider,
            analysis_option,
        )
    })
}

pub fn analyze_with<I>(
    runtime: &mut JsRuntime,
    language: &Language,
    rules: I,
    filename: &Arc<str>,
    code: &Arc<str>,
    argument_provider: &ArgumentProvider,
    analysis_option: &AnalysisOptions,
) -> Vec<RuleResult>
where
    I: IntoIterator,
    I::Item: Borrow<RuleInternal>,
{
    // check if we should ignore the file before doing any more expensive work.
    if analysis_option.ignore_generated_files && is_generated_file(code, language) {
        if analysis_option.use_debug {
            eprintln!("Skipping generated file {}", filename);
        }
        return vec![];
    }

    let lines_to_ignore = get_lines_to_ignore(code, language);

    let now = Instant::now();
    let Some(tree) = get_tree(code, language) else {
        if analysis_option.use_debug {
            eprintln!("error when parsing source file {filename}");
        }
        return vec![];
    };
    let tree = Arc::new(tree);
    let cst_parsing_time = now.elapsed();

    let split_filename = split_path(filename.as_ref());

    rules
        .into_iter()
        .map(|rule| {
            let rule = rule.borrow();
            if analysis_option.use_debug {
                eprintln!("Apply rule {} file {}", rule.name, filename);
            }

            let res = runtime.execute_rule(
                code,
                &tree,
                filename,
                rule,
                &argument_provider.get_arguments(&split_filename, &rule.name),
                Some(JAVASCRIPT_EXECUTION_TIMEOUT),
            );

            // NOTE: This is a translation layer to map Result<T, E> to a `RuleResult` struct.
            // Eventually, `analyze` should be refactored to also use a `Result`, and then this will no longer be required.
            let (violations, errors, execution_error, console_output, timing) = match res {
                Ok(execution) => {
                    let ExecutionResult {
                        mut violations,
                        console_lines,
                        timing,
                    } = execution;
                    let console_output = (!console_lines.is_empty() && analysis_option.log_output)
                        .then_some(console_lines.join("\n"));
                    violations.retain(|v| {
                        !lines_to_ignore.should_filter_rule(rule.name.as_str(), v.start.line)
                    });
                    (violations, vec![], None, console_output, timing)
                }
                Err(err) => {
                    let r_f = format!("{}:{}", rule.name, filename);
                    let (err_kind, execution_error) = match err {
                        DDSAJsRuntimeError::JavaScriptTimeout { timeout } => {
                            if analysis_option.use_debug {
                                eprintln!(
                                    "rule:file {} TIMED OUT ({} ms)",
                                    r_f,
                                    timeout.as_millis()
                                );
                            }
                            (ERROR_RULE_TIMEOUT, None)
                        }
                        other_err => {
                            let reason = other_err.to_string();
                            if analysis_option.use_debug {
                                eprintln!("rule:file {} execution error, message: {}", r_f, reason);
                            }
                            (ERROR_RULE_EXECUTION, Some(reason))
                        }
                    };
                    let errors = vec![err_kind.to_string()];
                    (vec![], errors, execution_error, None, Default::default())
                }
            };
            RuleResult {
                rule_name: rule.name.clone(),
                filename: filename.to_string(),
                violations,
                errors,
                execution_error,
                output: console_output,
                execution_time_ms: timing.execution.as_millis(),
                parsing_time_ms: cst_parsing_time.as_millis(),
                query_node_time_ms: timing.ts_query.as_millis(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::analysis::tree_sitter::get_query;
    use crate::model::common::Language;
    use crate::model::rule::{RuleCategory, RuleSeverity};

    const QUERY_CODE: &str = r#"
(function_definition
    name: (identifier) @name
  parameters: (parameters) @params
)
        "#;

    const PYTHON_CODE: &str = r#"
def foo(arg1):
    pass
        "#;

    // execution time must be more than 0
    #[test]
    fn test_execution_time() {
        let rule_code = r#"
function visit(node, filename, code) {
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    sleep(10);
    const functionName = node.captures["name"];
    if(functionName) {
        const error = buildError(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col,
                                 "invalid name", "CRITICAL", "security");

        const edit = buildEdit(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col, "update", "bar");
        const fix = buildFix("use bar", [edit]);
        addError(error.addFix(fix));
    }
}
        "#;

        let rule = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Python).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();
        let results = analyze(
            &Language::Python,
            &vec![rule],
            &Arc::from("myfile.py"),
            &Arc::from(PYTHON_CODE),
            &ArgumentProvider::new(),
            &analysis_options,
        );
        assert_eq!(1, results.len());
        let result = results.get(0).unwrap();
        assert_eq!(result.violations.len(), 1);
    }

    // execute two rules and check that both rules are executed and their respective
    // results reported.
    #[test]
    fn test_two_rules_executed() {
        let rule_code1 = r#"
function visit(node, filename, code) {
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    const functionName = node.captures["name"];
    if(functionName) {
        const error = buildError(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col,
                                 "invalid name", "CRITICAL", "security");

        const edit = buildEdit(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col, "update", "bar");
        const fix = buildFix("use bar", [edit]);
        addError(error.addFix(fix));
    }
}
        "#;
        let rule_code2 = r#"
function visit(node, filename, code) {
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    const functionName = node.captures["name"];
    if(functionName) {
        const error = buildError(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col,
                                 "invalid name", "CRITICAL", "security");

        const edit = buildEdit(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col, "update", "baz");
        const fix = buildFix("use baz", [edit]);
        addError(error.addFix(fix));
    }
}
        "#;

        let rule1 = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code1.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Python).unwrap(),
        };
        let rule2 = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code2.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Python).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();
        let results = analyze(
            &Language::Python,
            &vec![rule1, rule2],
            &Arc::from("myfile.py"),
            &Arc::from(PYTHON_CODE),
            &ArgumentProvider::new(),
            &analysis_options,
        );
        assert_eq!(2, results.len());
        let result1 = results.get(0).unwrap();
        let result2 = results.get(1).unwrap();
        assert_eq!(result1.violations.len(), 1);
        assert_eq!(result2.violations.len(), 1);
        assert_eq!(
            result1
                .violations
                .get(0)
                .unwrap()
                .fixes
                .get(0)
                .unwrap()
                .edits
                .get(0)
                .unwrap()
                .content
                .clone()
                .unwrap(),
            "bar".to_string()
        );
        assert_eq!(
            result2
                .violations
                .get(0)
                .unwrap()
                .fixes
                .get(0)
                .unwrap()
                .edits
                .get(0)
                .unwrap()
                .content
                .clone()
                .unwrap(),
            "baz".to_string()
        );
    }

    // execute two rules and check that both rules are executed and their respective
    // results reported.
    #[test]
    fn test_capture_unnamed_nodes() {
        let rule_code1 = r#"
function visit(node, filename, code) {

    const el = node.captures["less_than"];
    if(el) {
        const error = buildError(el.start.line, el.start.col, el.end.line, el.end.col,
                                 "do not use less than", "CRITICAL", "security");
        addError(error);
    }
}
        "#;

        let tree_sitter_query = r#"
(
    (for_statement
        condition: (_
            (binary_expression
                left: (identifier)
                operator: [
                    "<" @less_than
                    "<=" @less_than
                    ">" @more_than
                    ">=" @more_than
                ]
            )
        )
    )
)
        "#;

        let js_code = r#"
for(var i = 0; i <= 10; i--){}
        "#;

        let rule1 = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::JavaScript,
            code: rule_code1.to_string(),
            tree_sitter_query: get_query(tree_sitter_query, &Language::JavaScript).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();
        let results = analyze(
            &Language::JavaScript,
            &vec![rule1],
            &Arc::from("myfile.js"),
            &Arc::from(js_code),
            &ArgumentProvider::new(),
            &analysis_options,
        );
        assert_eq!(1, results.len());
        let result1 = results.get(0).unwrap();
        assert_eq!(result1.violations.len(), 1);
        assert_eq!(
            result1.violations.get(0).unwrap().message,
            "do not use less than".to_string()
        );
    }

    // do not execute the visit function when there is no match
    #[test]
    fn test_no_unnecessary_execute() {
        let rule_code1 = r#"
function visit(node, filename, code) {

    console.log("bla");
}
        "#;

        let tree_sitter_query = r#"

    (for_statement) @for_statement
    (#eq? @for_statement "bla")

        "#;

        let python_code = r#"
def foo():
  print("bar")
        "#;

        let rule1 = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code1.to_string(),
            tree_sitter_query: get_query(tree_sitter_query, &Language::Python).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();
        let results = analyze(
            &Language::Python,
            &vec![rule1],
            &Arc::from("myfile.py"),
            &Arc::from(python_code),
            &ArgumentProvider::new(),
            &analysis_options,
        );
        assert_eq!(1, results.len());
        let result1 = results.get(0).unwrap();
        assert!(result1.output.as_ref().is_none());
    }

    // test showing violation ignore
    #[test]
    fn test_violation_ignore() {
        let rule_code = r#"
function visit(node, filename, code) {
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    sleep(10);
    const functionName = node.captures["name"];
    if(functionName) {
        const error = buildError(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col,
                                 "invalid name", "CRITICAL", "security");

        const edit = buildEdit(functionName.start.line, functionName.start.col, functionName.end.line, functionName.end.col, "update", "bar");
        const fix = buildFix("use bar", [edit]);
        addError(error.addFix(fix));
    }
}
        "#;

        let c = r#"
# no-dd-sa
def foo(arg1):
    pass
        "#;
        let rule = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Python).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();
        let results = analyze(
            &Language::Python,
            &vec![rule],
            &Arc::from("myfile.py"),
            &Arc::from(c),
            &ArgumentProvider::new(),
            &analysis_options,
        );
        assert_eq!(1, results.len());
        let result = results.get(0).unwrap();
        assert!(result.violations.is_empty());
    }

    fn assert_lines_to_ignore(code: String, language: Language, rule: &'static str) {
        let lines_to_ignore = get_lines_to_ignore(code.as_str(), &language);
        assert_eq!(1, lines_to_ignore.lines_to_ignore_per_rule.len());
        assert_eq!(
            rule,
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&3)
                .unwrap()
                .get(0)
                .unwrap()
        );
    }

    #[test]
    fn test_get_lines_to_ignore_with_tabs_and_no_space_from_comment_symbol() {
        // no-dd-sa on line 2 so we ignore line 3 for rule
        let rule = "ruleset/rule1";
        // java
        let code = format!("\n\t//no-dd-sa:{rule}");
        assert_lines_to_ignore(code, Language::Java, rule);
        // js
        let code = format!("\n\t//no-dd-sa:{rule}");
        assert_lines_to_ignore(code, Language::JavaScript, rule);
        // python
        let code = format!("\n\t#no-dd-sa:{rule}");
        assert_lines_to_ignore(code, Language::Python, rule);
    }

    #[test]
    fn test_get_lines_to_ignore_python() {
        // no-dd-sa ruleset1/rule1 on line 3 so we ignore line 4 for ruleset1/rule1
        // no-dd-sa on line 7 so we ignore all rules on line 8
        let code = "\
foo

# no-dd-sa ruleset1/rule1

bar

# no-dd-sa
";

        let lines_to_ignore = get_lines_to_ignore(code, &Language::Python);

        // test lines to ignore for all rules
        assert_eq!(1, lines_to_ignore.lines_to_ignore.len());
        assert!(!lines_to_ignore.lines_to_ignore.contains(&1));
        assert!(lines_to_ignore.lines_to_ignore.contains(&8));

        // test lines to ignore for some rules
        assert_eq!(1, lines_to_ignore.lines_to_ignore_per_rule.len());
        assert!(lines_to_ignore.lines_to_ignore_per_rule.contains_key(&4));
        assert_eq!(
            1,
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&4)
                .unwrap()
                .len()
        );
        assert_eq!(
            "ruleset1/rule1",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&4)
                .unwrap()
                .get(0)
                .unwrap()
        );
    }

    #[test]
    fn test_get_lines_to_ignore_python_ignore_all_file() {
        let code = "\
#no-dd-sa
def foo():
  pass";

        let lines_to_ignore = get_lines_to_ignore(code, &Language::Python);
        assert!(lines_to_ignore.lines_to_ignore.is_empty());
        assert!(lines_to_ignore.lines_to_ignore_per_rule.is_empty());
        assert!(matches!(
            lines_to_ignore.ignore_file,
            FileIgnoreBehavior::AllRules
        ));
    }

    #[test]
    fn test_get_lines_to_ignore_python_ignore_all_file_specific_rules() {
        let code1 = "\
#no-dd-sa foo/bar
def foo():
  pass";

        let lines_to_ignore1 = get_lines_to_ignore(code1, &Language::Python);
        assert!(lines_to_ignore1.lines_to_ignore_per_rule.is_empty());
        assert_eq!(
            lines_to_ignore1.ignore_file,
            FileIgnoreBehavior::SomeRules(vec!["foo/bar".to_string()])
        );
        assert!(lines_to_ignore1.lines_to_ignore.is_empty());

        let code2 = "\
#no-dd-sa foo/bar ruleset/rule
def foo():
  pass";

        let lines_to_ignore2 = get_lines_to_ignore(code2, &Language::Python);

        assert!(lines_to_ignore2.lines_to_ignore_per_rule.is_empty());

        assert_eq!(
            lines_to_ignore2.ignore_file,
            FileIgnoreBehavior::SomeRules(vec!["foo/bar".to_string(), "ruleset/rule".to_string()])
        );
        assert!(lines_to_ignore2.lines_to_ignore.is_empty());
    }

    #[test]
    fn test_go_file_context() {
        let code = r#"
import (
    "math/rand"
    crand1 "crypto/rand"
    crand2 "crypto/rand"
)

func main () {

}
        "#;

        let query = r#"(function_declaration) @func"#;

        let rule_code = r#"
function visit(node, filename, code) {
    const n = node.captures["func"];
    console.log(node.context.packages);
    if(node.context.packages.includes("math/rand")) {
        const error = buildError(n.start.line, n.start.col, n.end.line, n.end.col, "invalid name", "CRITICAL", "security");
        addError(error);
    }
}
        "#;

        let rule = RuleInternal {
            name: "myrule".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Go,
            code: rule_code.to_string(),
            tree_sitter_query: get_query(query, &Language::Go).unwrap(),
        };

        let analysis_options = AnalysisOptions {
            log_output: true,
            ..Default::default()
        };
        let results = analyze(
            &Language::Go,
            &vec![rule],
            &Arc::from("myfile.go"),
            &Arc::from(code),
            &ArgumentProvider::new(),
            &analysis_options,
        );

        assert_eq!(1, results.len());
        let result = results.get(0).unwrap();
        let output = result.output.clone().unwrap();
        assert_eq!(result.violations.len(), 1);
        assert!(output.contains("\"math/rand\""));
        assert!(output.contains("\"crypto/rand\""));
    }

    #[test]
    fn test_get_lines_to_ignore_javascript() {
        // no-dd-sa ruleset1/rule1 on line 3 so we ignore line 4 for ruleset1/rule1
        // no-dd-sa on line 7 so we ignore all rules on line 8
        let code = r#"
 /*
 * no-dd-sa */
line4("bar");
/* no-dd-sa */
line6("bar");
// no-dd-sa ruleset/rule1,ruleset/rule2
line8("bar");
// no-dd-sa ruleset/rule1, ruleset/rule3
line10("bar");
/* no-dd-sa ruleset/rule1, ruleset/rule4 */
line12("bar");
/*no-dd-sa ruleset/rule1, ruleset/rule5*/
line14("bar");
// no-dd-sa:ruleset/rule1
line16("bar");
// no-dd-sa
line18("foo")
//no-dd-sa
line20("foo")
        "#;

        let lines_to_ignore = get_lines_to_ignore(code, &Language::JavaScript);

        // test lines to ignore for all rules
        assert_eq!(3, lines_to_ignore.lines_to_ignore.len());
        assert!(!lines_to_ignore.lines_to_ignore.contains(&1));
        assert!(lines_to_ignore.lines_to_ignore.contains(&18));
        assert!(lines_to_ignore.lines_to_ignore.contains(&20));
        assert_eq!(5, lines_to_ignore.lines_to_ignore_per_rule.len());
        assert_eq!(
            "ruleset/rule1",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&8)
                .unwrap()
                .get(0)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule2",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&8)
                .unwrap()
                .get(1)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule1",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&10)
                .unwrap()
                .get(0)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule3",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&10)
                .unwrap()
                .get(1)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule1",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&12)
                .unwrap()
                .get(0)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule4",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&12)
                .unwrap()
                .get(1)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule1",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&14)
                .unwrap()
                .get(0)
                .unwrap()
        );
        assert_eq!(
            "ruleset/rule5",
            lines_to_ignore
                .lines_to_ignore_per_rule
                .get(&14)
                .unwrap()
                .get(1)
                .unwrap()
        );
    }

    #[test]
    fn test_argument_values() {
        let rule_code = r#"
function visit(node, filename, code) {
    const functionName = node.captures["name"];
    const argumentValue = node.context.arguments['my-argument'];
    if (argumentValue !== undefined) {
        const error = buildError(
            functionName.start.line, functionName.start.col,
            functionName.end.line, functionName.end.col,
            `argument = ${argumentValue}`);
        addError(error);
    }
}
        "#;

        let rule1 = RuleInternal {
            name: "rule1".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Python).unwrap(),
        };
        let rule2 = RuleInternal {
            name: "rule2".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Python,
            code: rule_code.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Python).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();
        let mut argument_provider = ArgumentProvider::new();
        argument_provider.add_argument("rule1", &split_path("myfile.py"), "my-argument", "101");
        argument_provider.add_argument("rule1", &split_path("myfile.py"), "another-arg", "101");

        let results = analyze(
            &Language::Python,
            &vec![rule1, rule2],
            &Arc::from("myfile.py"),
            &Arc::from(PYTHON_CODE),
            &argument_provider,
            &analysis_options,
        );

        assert_eq!(2, results.len());
        let result1 = results.get(0).unwrap();
        let result2 = results.get(1).unwrap();
        assert_eq!(result1.violations.len(), 1);
        assert!(result1.violations[0].message.contains("argument = 101"));
        assert_eq!(result2.violations.len(), 0);
    }

    #[test]
    fn test_execution_for_starlark() {
        let rule_code = r#"
function visit(query, filename, code) {
    const functionName = query.captures.name;
    if (functionName) {
        const error = buildError(
            functionName.start.line, functionName.start.col,
            functionName.end.line, functionName.end.col,
            `invalid name`
        );
        addError(error);
    }
}"#;

        let rule = RuleInternal {
            name: "rule1".to_string(),
            short_description: Some("short desc".to_string()),
            description: Some("description".to_string()),
            category: RuleCategory::CodeStyle,
            severity: RuleSeverity::Notice,
            language: Language::Starlark,
            code: rule_code.to_string(),
            tree_sitter_query: get_query(QUERY_CODE, &Language::Starlark).unwrap(),
        };

        let analysis_options = AnalysisOptions::default();

        let starlark_code = r#"
def foo():
    pass
"#;

        let results = analyze(
            &Language::Starlark,
            &vec![rule],
            &Arc::from("myfile.star"),
            &Arc::from(starlark_code),
            &ArgumentProvider::new(),
            &analysis_options,
        );

        assert_eq!(results.len(), 1);
        let result = results.get(0).unwrap();
        assert_eq!(result.violations.len(), 1);
        assert_eq!(result.violations[0].message, "invalid name");
    }
}
