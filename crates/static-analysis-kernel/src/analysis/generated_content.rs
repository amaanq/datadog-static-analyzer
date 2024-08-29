use crate::model::common::Language;

pub const PROTOBUF_HEADER: &str = "Generated by the protocol buffer compiler.  DO NOT EDIT!";
pub const THRIFT_HEADER: &str = "Autogenerated by Thrift Compiler";

/// Max number of characters we use at the file header to detect if this is a generated file.
pub const MAX_HEADER_SIZE: usize = 400;

/// Returns if a file is generated or not based on a few heuristics.
/// Some heuristics are based on these sources
///  - https://github.com/github-linguist/linguist/blob/master/lib/linguist/generated.rb
///
/// We only look at the first few bytes of the code that are generally comments generated by
/// code generation tools. We look at most at [MAX_HEADER_SIZE] characters.
pub fn is_generated_file(full_content: &str, language: &Language) -> bool {
    let size_to_analyze = MAX_HEADER_SIZE.min(full_content.len());

    let content = &full_content.get(0..size_to_analyze).unwrap_or(full_content);
    match language {
        Language::Go => {
            content.contains("Code generated by")
                | content.contains(PROTOBUF_HEADER)
                | content.contains(THRIFT_HEADER)
        }
        Language::Java => {
            content.contains("generated by the protocol buffer compiler")
                | content.contains(PROTOBUF_HEADER)
                | content.contains(THRIFT_HEADER)
        }
        Language::JavaScript => {
            content.contains("Generated by PEG.js")
                | content.contains("GENERATED CODE -- DO NOT EDIT!")
                | content.contains(THRIFT_HEADER)
        }
        Language::Python => {
            content.contains("Generated protocol buffer code")
                | content.contains("Generated by the gRPC Python protocol compiler plugin")
                | content.contains("Code generated by")
                | content.contains(PROTOBUF_HEADER)
                | content.contains(THRIFT_HEADER)
        }
        Language::Ruby => content.contains(PROTOBUF_HEADER) | content.contains(THRIFT_HEADER),
        Language::TypeScript => {
            content.contains("Generated by PEG.js")
                | content.contains("GENERATED CODE -- DO NOT EDIT!")
                | content.contains(THRIFT_HEADER)
        }
        _ => false,
    }
}

/// Returns if a file is minified or not.
/// The heuristic for detecting minified files is based on the average line length being greater
/// than 110.
pub fn is_minified_file(content: &str, language: &Language) -> bool {
    if language == &Language::JavaScript {
        let lines = content.lines();
        if lines.count() == 0 {
            false
        } else {
            content.lines().map(|line| line.len()).sum::<usize>() / content.lines().count() > 110
        }
    } else {
        false
    }
}

/// Glob patterns that are, by default, excluded from analysis. These patterns are for paths
/// that often contain either vendored 3rd party dependencies or generated files.
pub const DEFAULT_IGNORED_GLOBS: &[&str] = &[
    // JavaScript
    "**/node_modules/**/*",
    "**/jspm_packages/**/*",
    "**/.next/**/*",
    "**/.vuepress/**/*",
    // Python
    "**/venv/**/*",
    "**/__pycache__/**/*",
    // Ruby
    "**/_vendor/bundle/ruby/**/*",
    "**/.vendor/bundle/ruby/**/*",
    "**/.bundle/**/*",
    // Java
    "**/.gradle/**/*",
];

#[cfg(test)]
mod tests {
    use crate::analysis::generated_content::{
        is_generated_file, is_minified_file, PROTOBUF_HEADER, THRIFT_HEADER,
    };
    use crate::model::common::Language;

    #[test]
    fn test_is_generated_file_java() {
        assert!(!is_generated_file(&"class Foobar", &Language::Java));
        assert!(is_generated_file(
            &"// generated by the protocol buffer compiler\n class Foobar{}",
            &Language::Java
        ));
        assert!(is_generated_file(
            &format!("// {}\n class Foobar{{}}", PROTOBUF_HEADER),
            &Language::Java
        ));
        assert!(is_generated_file(
            &format!("// {}\n class Foobar{{}}", THRIFT_HEADER),
            &Language::Java
        ));
    }

    #[test]
    fn test_is_generated_file_go() {
        assert!(!is_generated_file(&"fn func(){}", &Language::Go));
        assert!(is_generated_file(
            &"// Code generated by MockGen\nfn func(){}",
            &Language::Go
        ));
        assert!(is_generated_file(
            &format!("// {}\nfn func(){{}}", PROTOBUF_HEADER),
            &Language::Go
        ));
        assert!(is_generated_file(
            &format!("// {}\nfn func(){{}}", THRIFT_HEADER),
            &Language::Go
        ));
    }

    #[test]
    fn test_is_generated_file_python() {
        assert!(!is_generated_file(
            &"def foo():\n  pass\n",
            &Language::Python
        ));
        assert!(is_generated_file(
            &"# Code generated by some tool\ndef foo():\n  pass\n",
            &Language::Go
        ));
        assert!(is_generated_file(
            &format!("# {}\ndef foo():\n  pass\n", THRIFT_HEADER),
            &Language::Go
        ));
        assert!(is_generated_file(
            &format!("# {}\ndef foo():\n  pass\n", PROTOBUF_HEADER),
            &Language::Go
        ));
    }

    #[test]
    fn test_is_generated_file_ruby() {
        assert!(is_generated_file(
            &format!("# {}\ndef foo():\n  pass\n", THRIFT_HEADER),
            &Language::Ruby
        ));
        assert!(is_generated_file(
            &format!("# {}\ndef foo():\n  pass\n", PROTOBUF_HEADER),
            &Language::Ruby
        ));
    }

    #[test]
    fn test_is_generated_file_javascript() {
        assert!(!is_generated_file(
            &"function smtg(){}",
            &Language::JavaScript
        ));
        assert!(is_generated_file(
            &"// GENERATED CODE -- DO NOT EDIT!\nfunction smtg(){}",
            &Language::JavaScript
        ));
        assert!(is_generated_file(
            &"// Generated by PEG.js\nfunction smtg(){}",
            &Language::JavaScript
        ));
        assert!(is_generated_file(
            &format!("// {}\nfunction smtg(){{}}", THRIFT_HEADER),
            &Language::JavaScript
        ));
    }

    #[test]
    fn test_is_generated_file_typescript() {
        assert!(!is_generated_file(
            &"function smtg(){}",
            &Language::TypeScript
        ));
        assert!(is_generated_file(
            &"// GENERATED CODE -- DO NOT EDIT!\nfunction smtg(){}",
            &Language::TypeScript
        ));
        assert!(is_generated_file(
            &"// Generated by PEG.js\nfunction smtg(){}",
            &Language::TypeScript
        ));
        assert!(is_generated_file(
            &format!("// {}\nfunction smtg(){{}}", THRIFT_HEADER),
            &Language::TypeScript
        ));
    }

    #[test]
    fn test_is_minified_file_javascript() {
        assert!(is_minified_file(
            &"var x = 2;".repeat(100),
            &Language::JavaScript
        ));
    }
}
