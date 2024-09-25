// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License, Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2024 Datadog, Inc.

import { Digraph, EDGE_ASSIGNMENT, EDGE_DEPENDENCE } from "ext:ddsa_lib/flow/graph";

const { op_java_get_bin_expr_operator } = Deno.core.ops;

/**
 * A graph describing the flow of variables within a single method.
 *
 * # Limitations
 * This graph cuts numerous corners in the interest of implementation simplicity:
 *
 * ## Block scoping
 * Block scoping is unsupported.
 * For example:
 * ```java
 * int someVariable = 123;
 * if (shouldProceed) {
 *     int someVariable = 456;
 *     System.out.println(value);
 *     someVariable = 789;
 * }
 * System.out.println(someVariable); // At this point, we'll think `someVariable` is 789.
 * ```
 * ## Name resolution
 * Name resolution is unsupported. All identifiers are treated equally.
 *
 * ## Type resolution
 * Type resolution is unsupported.
 *
 * ## Control Flow
 * Mutually exclusive branches are not treated as such -- rather, they are treated as if they are sequential.
 * For example:
 * ```java
 * String query = "";
 * if (valid) {
 *     query = taintedData;
 * } else {
 *     query = "safe";
 * }
 * ```
 * We effectively treat the above program as:
 * ```java
 * String query = "";
 * {
 *     query = taintedData;
 * }
 * {
 *     query = "safe";
 * }
 * ```
 * NB: In the future, we will handle this by reconciling and merging variable definitions at
 * the relevant control flow merge points using a simplified approach inspired by static single assignment (SSA) phi nodes.
 */
export class MethodFlow {
    /**
     * @param {TreeSitterNode} methodDecl The node of a `method_declaration`.
     */
    constructor(methodDecl) {
        if (methodDecl.cstType !== "method_declaration") {
            throw new Error("MethodFlow can only be constructed from a `method_declaration` node.");
        }

        /**
         * The `method_declaration` node this {@link MethodFlow} represents.
         * @type {TreeSitterNode}
         * @private
         */
        this.methodDecl = methodDecl;

        /**
         * As the CST is traversed, we construct an abstract state of the program. At each CST node, we track
         * the last tainted expression node (if any), and use that to propagate the taint between nodes in the graph.
         * This variable is thus used to allow (indirect) data passing between recursive visitor function invocations.
         * @type {TreeSitterNode | undefined}
         */
        this.lastTaintSource = undefined;

        /**
         * A graph of taint propagation.
         * @type {Digraph}
         */
        this.graph = new Digraph();

        /**
         * A list of definitions from a variable name to its most recent value. This is stateful
         * and is mutated as the CST is traversed.
         *
         * @type {Map<String, NodeId>}
         */
        this.currentDefinition = new Map();

        this.visitMethodDecl(methodDecl);
    }

    /**
     * Returns the {@link TreeSitterNode} of the method declaration that contains the provided `node`, if it exists.
     * @param {TreeSitterNode} node
     * @returns {TreeSitterNode | undefined} A node with `cstType === "method_declaration"`.
     */
    static findContainingMethod(node) {
        let current = node;
        while (current.cstType !== "method_declaration") {
            current = globalThis.ddsa.getParent(current);
            if (current === undefined) {
                // If we're at the tree root and haven't found a `method_declaration` yet, the original `node` was not
                // nested within a method. Return undefined.
                return undefined;
            }
        }
        return current;
    }


    /**
     * Visits the provided `node`.
     * @param {TreeSitterNode} node
     */
    visit(node) {
        switch (node.cstType) {
            // Expressions
            case "argument_list":
                this.visitArgList(node);
                break;
            case "array_access":
                this.visitArrayAccessExpr(node);
                break;
            case "array_creation_expression":
                this.visitArrayCreationExpr(node);
                break;
            case "array_initializer":
                this.visitArrayInitExpr(node);
                break;
            case "assignment_expression":
                this.visitAssignExpr(node);
                break;
            case "binary_expression":
                this.visitBinExpr(node);
                break;
            case "cast_expression":
                this.visitCastExpr(node);
                break;
            case "field_access":
                this.visitFieldAccess(node);
                break;
            case "identifier":
                this.visitIdentifier(node);
                break;
            case "lambda_expression":
                this.visitLambdaExpr(node);
                break;
            case "method_invocation":
                this.visitMethodCall(node);
                break;
            case "method_reference":
                this.visitMethodRefExpr(node);
                break;
            case "object_creation_expression":
                this.visitObjCreationExpr(node);
                break;
            case "parenthesized_expression":
                this.visitParensExpr(node);
                break;
            case "template_expression":
                this.visitTemplateExpr(node);
                break;
            case "ternary_expression":
                this.visitTernaryExpr(node);
                break;

            // Statements
            case "block":
                this.visitBlockStmt(node);
                break;
            case "do_statement":
                this.visitDoStmt(node);
                break;
            case "enhanced_for_statement":
                this.visitEnhancedForStmt(node);
                break;
            case "expression_statement":
                this.visitExprStmt(node);
                break;
            case "for_statement":
                this.visitForStmt(node);
                break;
            case "if_statement":
                this.visitIfStmt(node);
                break;
            case "labeled_statement":
                this.visitLabeledStmt(node);
                break;
            case "local_variable_declaration":
                this.visitLocalVarDecl(node);
                break;
            case "method_declaration":
                // [simplification] We do not support methods defined within other methods. Thus, while we
                // do have `visitMethodDecl`, we do not want to invoke it here.
                break;
            case "switch_expression":
                this.visitSwitchExpr(node);
                break;
            case "synchronized_statement":
                this.visitSynchronizedStmt(node);
                break;
            case "try_statement":
                this.visitTryStmt(node);
                break;
            case "try_with_resources_statement":
                // TODO(JF): After scoped variable support: add (resource_specification (resource)+) to defs
                break;
            case "while_statement":
                this.visitWhileStmt(node);
                break;

            // Literals:
            case "binary_integer_literal":
            case "character_literal":
            case "decimal_integer_literal":
            case "decimal_floating_point_literal":
            case "false":
            case "hex_floating_point_literal":
            case "hex_integer_literal":
            case "null_literal":
            case "octal_integer_literal":
            case "string_literal":
            case "true":
                this.visitLiteral(node);
                break;
            // Jump statements (Handled within individual visit functions)
            case "break_statement":
            case "return_statement":
            case "throw_statement":
            case "continue_statement":
            case "yield_statement":
                break;
            // Comments
            case "block_comment":
            case "line_comment":
                break;
            // Not handled:
            case "class_declaration":
                break;
            default:
                // (Support for other node types has not been implemented)
                break;
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    // Visitors
    ///////////////////////////////////////////////////////////////////////////

    // Expressions
    //////////////

    /**
     * Visits an `argument_list`.
     * ```java
     *     example_01();
     * //            ^^
     *     example_02(1, 2, 3);
     * //            ^^^^^^^^^
     * ```
     * ```
     * (argument_list (_)*)
     * ```
     * @param {TreeSitterNode} node
     */
    visitArgList(node) {
        const children = ddsa.getChildren(node);
        for (const child of children) {
            this.visit(child);
            this.propagateLastTaint(node);
        }
    }

    /**
     * Visits an `array_access`.
     * ```java
     *     String example_01 = data[2];
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (array_access array: (_) index: (_))
     * ```
     * @param {TreeSitterNode} node
     */
    visitArrayAccessExpr(node) {
        // (Note: the `array` field can be an arbitrary expression)
        const children = ddsa.getChildren(node);
        const arrayIdx = findFieldIndex(children, 0, "array");
        const array = children[arrayIdx];

        this.visit(array);
        this.propagateLastTaint(node);
    }

    /**
     * Visits an `array_creation_expression`.
     * ```java
     * var test = new String[]{"hello", someVar};
     * //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (type: (_) dimensions: (dimensions) value: (array_initializer))
     * ```
     * @param {TreeSitterNode} node
     */
    visitArrayCreationExpr(node) {
        // Each value needs to be visited, as it can contain an arbitrary expression.
        const children = ddsa.getChildren(node);

        const valueIdx = findFieldIndex(children, 2, "value");
        const value = children[valueIdx];
        this.visit(value);
        this.propagateLastTaint(node);
    }

    /**
     * Visits an `array_initializer`.
     * ```java
     * var example_01 = new String[]{"hello", someVar};
     * //                           ^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (array_initializer (_)*)
     * ```
     * @param {TreeSitterNode} node
     */
    visitArrayInitExpr(node) {
        // Each child is a different expression:
        const children = ddsa.getChildren(node);

        for (const child of children) {
            this.visit(child);
            this.propagateLastTaint(node);
        }
    }

    /**
     * Visits an `assignment_expression`.
     * ```java
     *     example_01 = 123;
     * //  ^^^^^^^^^^^^^^^^^
     *     example_02 += "some string";
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (assignment_expression left: (identifier) right: (_))
     * ```
     * @param {TreeSitterNode} node
     */
    visitAssignExpr(node) {
        const children = ddsa.getChildren(node);

        const rhsIdx = findFieldIndex(children, 1, "right");
        const rhsExpr = children[rhsIdx];
        this.visit(rhsExpr);

        const lhsIdx = findFieldIndex(children, 0, "left");
        const name = children[lhsIdx];

        // [simplification]: assume the operator in this case is an `=`, making this a true assignment.
        //                   (if the operator was, e.g. `+=`, we would have a "dependence", not assignment).
        // The current definition for "name" is now `rhsExpr`.
        this.graph.addTypedEdge(name.id, rhsExpr.id, EDGE_ASSIGNMENT);


        this.markCurrentDefinition(name);
        // Reset the current taint status.
        const _ = this.takeLastTainted();
    }

    /**
     * Visits a `binary_expression`.
     * ```java
     *     example_01 + b;
     * //  ^^^^^^^^^^^^^^
     * ```
     * ```
     * (binary_expression left: (_) right: (_))
     * ```
     * @param {TreeSitterNode} node
     */
    visitBinExpr(node) {
        /** @type {BinExprOp | -1} */
        const operator = op_java_get_bin_expr_operator(node.id);
        // Only certain binary expressions can propagate taint:
        switch (operator) {
            // Strings can be concatenated/mutated via an addition operation.
            case BIN_EXPR_OP_ADD: {
                const _ = this.takeLastTainted();

                const children = ddsa.getChildren(node);

                // (start index is 1 to account for preceding "left" field)
                const rightIdx = findFieldIndex(children, 1, "right");
                const right = children[rightIdx];
                this.visit(right);
                this.propagateLastTaint(node);

                const leftIdx = findFieldIndex(children, 0, "left");
                const left = children[leftIdx];
                this.visit(left);
                this.propagateLastTaint(node);

                break;
            }
            default:
                break;
        }
    }

    /**
     * Visits a `cast_expression`.
     * ```java
     * Object upStr = "Hello World";
     * // Downcasting:
     * String name = (String) upStr;
     * //            ^^^^^^^^^^^^^^
     * // Casting:
     * Float temperature = (float) 98.6;
     * //                  ^^^^^^^^^^^^
     * ```
     * ```
     * (cast_expression type: (_) value: (_))
     * ```
     * @param {TreeSitterNode} node
     */
    visitCastExpr(node) {
        const children = ddsa.getChildren(node);

        const valueIdx = findFieldIndex(children, 1, "value");
        const value = children[valueIdx];
        this.visit(value);
        this.propagateLastTaint(node);
    }

    /**
     * Visits a `field_access`.
     * ```java
     *     example_01.field = 123;
     * //  ^^^^^^^^^^^^^^^^
     *     example_02.inner_01.inner_02.someMethod();
     * //  ^^^^^^^^^^^^^^^^^^^
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (field_access object: (_) field: (_))
     * ```
     * @param {TreeSitterNode} _node
     */
    visitFieldAccess(_node) {
        // [simplification]: Given that we are operating on a CST and don't have name resolution, it's not
        // straightforward to determine the nature of the field access. Thus, we ignore it.
    }

    /**
     * Visits an `identifier`.
     * ```java
     * // Non-exhaustive examples:
     *     int someName = 1234;
     * //      ^^^^^^^^
     *     doAction( someParam, another );
     * //  ^^^^^^^^  ^^^^^^^^^  ^^^^^^^
     * ```
     * ```
     * (identifier)
     * ```
     * @param {TreeSitterNode} node
     */
    visitIdentifier(node) {
        const currentDef = this.lookupIdentifier(node.text);
        // If this identifier has a known definition, create a dependence edge.
        if (currentDef !== undefined) {
            // Given the following code:
            // ```java
            // int y = 10;          // L1
            // y = 20;              // L2
            // int z = y + 5;       // L3
            // ```
            // If we are visiting the expression on line 3:
            // We intuitively know that the `y` on L3 refers to the `y` on L2, not the `y` on L1.
            //
            // To establish this fact within our graph, we create a dependence edge from L3's `identifier` node to L2's.
            //
            // And then to our analysis, we can effectively have:
            // ```java
            // int y_1 = 10;        // L1
            // int y_2 = 20;        // L2
            // int z_1 = y_2 + 5;   // L3
            // ```
            this.graph.addTypedEdge(node.id, currentDef, EDGE_DEPENDENCE);
        } else {
            // If this is a valid program and there is no known definition here, it is either that:
            // 1. We're visiting this `identifier` recursively within a variable declarator visitor.
            //    In this case, an `EDGE_ASSIGNMENT` will be created by _that_ visitor (i.e. after this `visitIdentifier`).
            // 2. The identifier has a definition outside our tracked scope.
        }
        // Because we're operating on a CST and not an AST, we can't easily distinguish the semantic context of an `identifier` node:
        // For example:
        // ```java
        // String x = "SELECT * FROM users WHERE name = " + someUserInput;
        //                                                  ^^^^^^^^^^^^^ 01. `identifier`
        // System.out.println("Done");
        //            ^^^^^^^ 02. `identifier`
        //        ^^^ 03. `identifier`
        // ^^^^^^ 04. `identifier`
        // ```
        //
        // We want to track #01 with `this.markLastTainted` (as here, the `identifier` node represents a variable).
        // However, we _don't_ want to mark #02, #03, #04 as "tainted".
        //
        // The way we ensure this is by only intentionally calling "visitIdentifier" from relevant visitors (e.g. `field_access`)
        // if we've determined that the `identifier` actually represents a variable.
        this.markLastTainted(node);
    }

    /**
     * Visits one of:
     * * `binary_integer_literal`
     * * `character_literal`
     * * `decimal_integer_literal`
     * * `decimal_floating_point_literal`
     * * `false`
     * * `hex_floating_point_literal`
     * * `hex_integer_literal`
     * * `null_literal`
     * * `octal_integer_literal`
     * * `string_literal`
     * * `true`
     *
     * ```
     * (_literal (_)*)
     * ```
     * @param {TreeSitterNode} node
     */
    visitLiteral(node) {
        // [simplification]: We currently don't utilize techniques like constant propagation, so literals are ignored.
    }

    /**
     * Visits a `lambda_expression`.
     * ```java
     *     example_01.forEach((v) -> v + "!");
     * //                     ^^^^^^^^^^^^^^
     *     example_02 = ((Supplier<String>) () -> { return "abc"; }).get();
     * //                                   ^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (lambda_expression parameters: (_) body: (_))
     * ```
     * @param {TreeSitterNode} node
     */
    visitLambdaExpr(node) {
        // [simplification]: Ignore this node
    }

    /**
     * Visits a `method_invocation`.
     * ```java
     *     example_01.someMethod();
     * //  ^^^^^^^^^^^^^^^^^^^^^^^
     *     String.join(", ", example_02);
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (method_invocation <object: (_)>? name: (identifier)  arguments: (argument_list))
     * ```
     * @param {TreeSitterNode} node
     */
    visitMethodCall(node) {
        const children = ddsa.getChildren(node);
        const objIdx = findFieldIndex(children, 0, "object");
        // [(identifier) (field_access)]
        const obj = children[objIdx];
        if (obj?.cstType === "identifier") {
            // [simplification]: If the node could represent a local variable, propagate taint as if that local variable
            // always taints the return value of an instance method (this is clearly not always the case).
            this.visitIdentifier(obj);
            this.propagateLastTaint(node);
            const _ = this.takeLastTainted();
        }

        // [simplification]: Ignore the "name" field (we don't do name or type resolution).

        const argsIdx = findFieldIndex(children, objIdx + 1, "arguments");
        const args = children[argsIdx];
        this.visitArgList(args);

        // [simplification]: Propagate tainted arguments as if they _always_ flow through into the return value
        // of the method (this is clearly not always the case).
        this.propagateLastTaint(node);
    }

    /**
     * Visits a `method_reference`.
     * ```java
     *     example_01.forEach(System.out::println);
     * //                     ^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (method_reference (_)+)
     * ```
     * @param {TreeSitterNode} node
     */
    visitMethodRefExpr(node) {
        // [simplification]: Ignore this node
    }

    /**
     * Visits an `object_creation_expression`.
     * ```java
     *     new Example_01();
     * //  ^^^^^^^^^^^^^^^^
     *     new Example_02().new InnerClass();
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (object_creation_expression (object_creation_expression)? type: (_) arguments: (argument_list))
     * ```
     * @param {TreeSitterNode} _node
     */
    visitObjCreationExpr(_node) {
        // [simplification]: Ignore this node
    }

    /**
     * Visits a `parenthesized_expression`.
     * ```java
     * int example_01 = (1234);
     * //               ^^^^^^
     * ```
     * ```
     * (parenthesized_expression (_))
     * ```
     *
     * @param {TreeSitterNode} node
     */
    visitParensExpr(node) {
        const children = ddsa.getChildren(node);
        for (const child of children) {
            // The first non-comment node is the wrapped expression.
            if (!isCommentNode(child)) {
                this.visit(child);
                this.propagateLastTaint(node);
                break;
            }
        }
    }

    /**
     * Visits a `template_expression`.
     * ```java
     * String query = STR."SELECT * FROM users where username='\{userInput}'";
     * //             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (template_expression template_processor: (identifier) template_argument: (string_literal))
     * ```
     *
     * @param {TreeSitterNode} node
     */
    visitTemplateExpr(node) {
        const children = ddsa.getChildren(node);
        const processorIdx = findFieldIndex(children, 0, "template_processor");

        // To be conservative, we currently only attempt to parse `STR` and `FMT`.
        const processor = children[processorIdx];
        switch (processor.text) {
            case "STR":
            case "FMT":
                break;
            default:
                return;
        }

        const templateArgIdx = findFieldIndex(children, processorIdx + 1, "template_argument");
        const templateArg = children[templateArgIdx];

        const stringLitChildren = ddsa.getChildren(templateArg);
        // (string_literal [(string_fragment) (string_interpolation (_))]*)
        for (const stringLitChild of stringLitChildren) {
            if (stringLitChild.cstType === "string_interpolation") {
                // (string_interpolation (_))
                const interChildren = ddsa.getChildren(stringLitChild);
                for (const child of interChildren) {
                    if (!isCommentNode(child)) {
                        this.visit(child);
                        this.propagateLastTaint(node);
                    }
                }
            }
        }
    }

    /**
     * Visits a `ternary_expression`.
     * ```java
     *     example_01 = isValid ? someVar : otherVar;
     * //               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (ternary_expression condition: (_) consequence: (_) alternative: (_))
     * ```
     *
     * # Note
     * [simplification]: This uses the same control flow logic as {@link MethodFlow.visitIfStmt}.
     *
     * @param {TreeSitterNode} node
     */
    visitTernaryExpr(node) {
        const children = ddsa.getChildren(node);
        // In the `condition` field, external variables can be mutated, but this is a corner case we
        // explicitly disregard, and so we only process the `consequence`.
        ignoreMutatingField(/* condition */);

        // See `visitIfStmt` for a caveat on how we're handling branches.
        const conseqIdx = findFieldIndex(children, 1, "consequence");
        const conseq = children[conseqIdx];
        this.visit(conseq);
        this.propagateLastTaint(node);

        const altIdx = findFieldIndex(children, conseqIdx + 1, "alternative");
        const alternative = children[altIdx];
        this.visit(alternative);
        this.propagateLastTaint(node);
    }

    // Statements
    //////////////

    /**
     * Visits a `block`.
     * ```java
     * // Non-exhaustive examples:
     *     void myMethod()
     * //  vvvvvvvvvvvvvvvv
     *     {
     *         // some code
     *     }
     * //  ^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (block (_)*)
     * ```
     * @param {TreeSitterNode} node
     */
    visitBlockStmt(node) {
        // (NB: If we supported scoping, we would enter a scope here)

        // A block's children is a list of statements and expressions. Each should be visited in order.
        const exprStmts = ddsa.getChildren(node);
        this._visitExprStmtList(node, exprStmts);

        // (NB: If we supported scoping, we would exit a scope here)
    }

    /**
     * Visits a list of nodes that are expressions and statements in sequential order.
     * @param {TreeSitterNode} parent An ancestor of {@link nodes} which should receive any tainted return values.
     * @param {Array<TreeSitterNode>} nodes
     */
    _visitExprStmtList(parent, nodes) {
        outer: for (const node of nodes) {
            this.visit(node);
            switch (node.cstType) {
                case "break_statement":
                case "throw_statement":
                case "continue_statement":
                    // All subsequent nodes are unreachable.
                    break outer;
                case "return_statement":
                case "yield_statement":
                    this.propagateLastTaint(parent);
                    // All subsequent nodes are unreachable.
                    break outer;
                default:
                    break;
            }
        }
    }

    /**
     * Visits a `do_statement`.
     * ```java
     *     do { } while (example_01);
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (do_statement body: (block) condition: (parenthesized_expression))
     * ```
     * @param {TreeSitterNode} node
     */
    visitDoStmt(node) {
        const children = ddsa.getChildren(node);
        const bodyIdx = findFieldIndex(children, 0, "body");
        const body = children[bodyIdx];
        this.visitBlockStmt(body);

        ignoreMutatingField(/* "condition" */);
    }

    /**
     * Visits an `enhanced_for_statement`.
     * ```java
     *     for (String example_01 : arr) { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (enhanced_for_statement type: (_) name: (identifier) value: (_) body: (block))
     * ```
     * @param {TreeSitterNode} node
     */
    visitEnhancedForStmt(node) {
        const children = ddsa.getChildren(node);
        ignoreMutatingField(/* "value" */);

        const bodyIdx = findFieldIndex(children, 3, "body");
        const body = children[bodyIdx];
        this.visitBlockStmt(body);
    }

    /**
     * Visits an `expression_statement`.
     * ```java
     * // Non-exhaustive examples:
     *     example_01;
     * //  ^^^^^^^^^^^
     *     example_02 + 1234;
     * //  ^^^^^^^^^^^^^^^^^^
     *     example_03.someMethod();
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (expression_statement (_))
     * ```
     * @param {TreeSitterNode} node
     */
    visitExprStmt(node) {
        // (NB: The first child cannot be a comment, so it is safe to manually index into this array)
        const innerExpr = ddsa.getChildren(node)[0];
        this.visit(innerExpr);
        const _ = this.takeLastTainted();
    }

    /**
     * Visits a `for_statement`.
     * ```java
     *     for (int i = 0, j = 0, example_01 = 0; i < 3; i++, j += 2) { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     *     for (;;) { } // example_02
     * //  ^^^^^^^^^^^^
     * ```
     * ```
     * (for_statement <init: (_)>? <condition: (_)>? <update: (_)>* body: (block))
     * ```
     * @param {TreeSitterNode} node
     */
    visitForStmt(node) {
        const children = ddsa.getChildren(node);

        // The index of the first "update" child field detected.
        let updateFieldIdx = -1;

        const len = children.length;
        for (let i = 0; i < len; i++) {
            const child = children[i];
            if (isCommentNode(child)) {
                continue;
            }
            switch (child.fieldName) {
                case "init":
                    this.visit(child);
                    // TODO(JF): After scoped variable support: propagate taint here
                    break;
                case "condition":
                    // noop
                    break;
                case "update":
                    // (We visit "update" fields _after_ the "body" field name to do a rough approximation of the CFG,
                    // so we break within this branch and handle it afterward).
                    if (updateFieldIdx === -1) {
                        updateFieldIdx = i;
                    }
                    break;
                case "body":
                    this.visitBlockStmt(child);
                    break;
                default:
                    throw new Error("unreachable");
            }
        }

        if (updateFieldIdx !== -1) {
            for (let i = updateFieldIdx; i < len; i++) {
                const child = children[i];
                this.visit(child);
                // TODO(JF): After scoped variable support: propagate taint here
            }
        }
    }

    /**
     * Visits an `if_statement`.
     * ```java
     *     if (example_01) { }
     * //  ^^^^^^^^^^^^^^^^^^^
     *    if (example_02) { } else { }
     * // ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (if_statement
     *     condition: (parenthesized_expression)
     *     consequence: (block)
     *     <alternative: [(block) (if_statement)>?)
     * ```
     *
     * # Note
     * [simplification]: See caveats under `Control Flow` in {@link MethodFlow}.
     *
     * @param {TreeSitterNode} node
     */
    visitIfStmt(node) {
        const children = ddsa.getChildren(node);
        // In the `condition` field, external variables can be mutated, but this is a corner case we
        // explicitly disregard, and so we only process the `consequence`.
        ignoreMutatingField(/* condition */);

        const conseqIdx = findFieldIndex(children, 1, "consequence");
        const conseq = children[conseqIdx];
        this.visitBlockStmt(conseq);

        const altIdx = findFieldIndex(children, conseqIdx + 1, "alternative");
        if (altIdx !== -1) {
            const alternative = children[altIdx];
            this.visit(alternative);
        }
    }

    /**
     * Visits a `labeled_statement`.
     * ```java
     * //  vvvvvvvvvvv
     *     example_01:
     *     for (i = 0; i < 3; i++) { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (labeled_statement (identifier) (_)+)
     * ```
     * @param {TreeSitterNode} node
     */
    visitLabeledStmt(node) {
        const children = ddsa.getChildren(node);
        const len = children.length;
        // Skip the (identifier):
        for (let i = 1; i < len; i++) {
            const child = children[i];
            this.visit(child);
        }
    }

    /**
     * Visits a `local_variable_declaration`.
     * ```java
     *     int example_01 = 1234;
     * //  ^^^^^^^^^^^^^^^^^^^^^^
     *     int example_02 = 1, example_03 = 2;
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     *     int example_04;
     * //  ^^^^^^^^^^^^^^^
     * ```
     * ```
     * (local_variable_declaration type: (_) <declarator: (variable_declarator)>+)
     * ```
     * @param {TreeSitterNode} node
     */
    visitLocalVarDecl(node) {
        const children = ddsa.getChildren(node);

        for (let i = 1; i < children.length; i++) {
            const child = children[i];
            if (child.fieldName !== "declarator") {
                continue;
            }

            // (variable_declarator name: (identifier) <value: (_)>?)
            const declaratorChildren = ddsa.getChildren(child);
            const nameIdx = findFieldIndex(declaratorChildren, 0, "name");
            const name = declaratorChildren[nameIdx];

            const valueIdx = findFieldIndex(declaratorChildren, nameIdx + 1, "value");
            if (valueIdx === -1) {
                // A variable may not be initialized with a value.
                continue;
            }

            const rhsExpr = declaratorChildren[valueIdx];
            this.visit(rhsExpr);

            this.graph.addTypedEdge(name.id, rhsExpr.id, EDGE_ASSIGNMENT);
            this.markCurrentDefinition(name);
            // Reset the current taint status.
            const _ = this.takeLastTainted();
        }
    }

    /**
     * Visits a `method_declaration`.
     * ```java
     *     void example_01() { }
     * //  ^^^^^^^^^^^^^^^^^^^^^
     *     static void example_02() { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     *     void example_03() throws SomeException { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     *     <T> T example_04(T data) { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (method_declaration
     *     (modifiers)?
     *     <type_parameters: (type_parameters)>?
     *     type: (_)
     *     name: (identifier)
     *     parameters: (formal_parameters [(formal_parameter) (spread_parameter)]*)
     *     (throws)?
     *     body: (block))
     * ```
     * @param {TreeSitterNode} node
     */
    visitMethodDecl(node) {
        const children = ddsa.getChildren(node);
        const formalParamsIdx = findFieldIndex(children, 2, "parameters");
        const formalParams = children[formalParamsIdx];

        const formalParamsChildren = ddsa.getChildren(formalParams);
        for (const param of formalParamsChildren) {
            const paramChildren = ddsa.getChildren(param);

            if (param.cstType === "formal_parameter") {
                // (formal_parameter type: (_) name: (identifier))
                const nameIdx = findFieldIndex(paramChildren, 1, "name");
                const name = paramChildren[nameIdx];
                this.markCurrentDefinition(name);
            } else if (param.cstType === "spread_parameter") {
                // (spread_parameter (type_identifier) (variable_declarator))
                const spreadParamChildren = ddsa.getChildren(param);
                for (const paramChild of spreadParamChildren) {
                    if (paramChild.cstType === "variable_declarator") {
                        // (variable_declarator name: (identifier) <value: (_)>?)
                        const varDeclChildren = ddsa.getChildren(paramChild);
                        const nameIdx = findFieldIndex(varDeclChildren, 0, "name");
                        const name = varDeclChildren[nameIdx];
                        this.markCurrentDefinition(name);
                    }
                }
            }
        }

        const bodyIdx = findFieldIndex(children, formalParamsIdx + 1, "body");
        const body = children[bodyIdx];
        this.visitBlockStmt(body);
    }

    /**
     * Visits a `switch_expression`.
     * ```java
     * //  Can semantically behave as a "statement"...
     * //  vvvvvvvvvvvvvvvvvvvvv
     *     switch (example_01) {
     *         case x:
     *             break;
     *         default:
     *             break;
     *     }
     * //  ^^^^^^^^^^^^^^^^^^^^^
     *
     * //  ...or as an "expression".
     * //                 vvvvvvvvvvvvvvvvvvvvv
     *     String value = switch (example_02) {
     *         case 123:
     *             yield "one two three";
     *         default:
     *             yield "some string";
     *     };
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (switch_expression condition: (parenthesized_expression) body: (switch_block))
     * ```
     *
     * @param {TreeSitterNode} node
     */
    visitSwitchExpr(node) {
        const children = ddsa.getChildren(node);
        ignoreMutatingField(/* "condition" */);

        const switchBlockIdx = findFieldIndex(children, 1, "body");
        const switchBlock = children[switchBlockIdx];

        // (switch_block
        //     (switch_block_statement_group
        //         (switch_label (_))
        //         (_)*
        //     )*
        // )
        const switchGroups = ddsa.getChildren(switchBlock);
        for (const switchGroup of switchGroups) {
            if (!(switchGroup.cstType === "switch_block_statement_group")) {
                continue;
            }
            const groupChildren = ddsa.getChildren(switchGroup);

            // Visit everything after the `switch_label`.
            const exprStmts = groupChildren.slice(1);
            this._visitExprStmtList(node, exprStmts);
        }
    }

    /**
     * Visits a `synchronized_statement`.
     * ```java
     *     Example01 obj = new Example01();
     *     synchronized (obj.field) { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (synchronized_statement (parenthesized_statement) body: (block))
     * ```
     * @param {TreeSitterNode} node
     */
    visitSynchronizedStmt(node) {
        const children = ddsa.getChildren(node);
        // TODO(JF): After scoped variable support: add (parenthesized_statement) to defs

        const bodyIdx = findFieldIndex(children, 1, "body");
        const body = children[bodyIdx];
        this.visitBlockStmt(body);
    }

    /**
     * Visits a `try_statement`.
     * ```java
     *     try { } catch (Exception example_01) { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     *     try { } catch (Exception e) { } finally { }
     * //  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     *     try { } finally { }
     * //  ^^^^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (try_statement body: (block) [((catch_clause) (finally_clause)) (catch_clause) (finally_clause)])
     * ```
     * @param {TreeSitterNode} node
     */
    visitTryStmt(node) {
        const children = ddsa.getChildren(node);
        const tryBlockIdx = findFieldIndex(children, 0, "body");
        const tryBlock = children[tryBlockIdx];
        this.visitBlockStmt(tryBlock);

        const len = children.length;
        for (let i = tryBlockIdx + 1; i < len; i++) {
            const child = children[i];
            switch (child.cstType) {
                // (catch_clause (catch_formal_parameter) body: (block))
                case "catch_clause": {
                    const catchChildren = ddsa.getChildren(child);
                    const bodyIdx = findFieldIndex(catchChildren, 1, "body");
                    const body = catchChildren[bodyIdx];
                    this.visitBlockStmt(body);
                    break;
                }
                // (finally_clause (block))
                case "finally_clause": {
                    const finallyChildren = ddsa.getChildren(child);
                    for (const child of finallyChildren) {
                        if (child.cstType === "block") {
                            this.visitBlockStmt(child);
                            break;
                        }
                    }
                    break;
                }
                case "block_comment":
                case "line_comment":
                    break;
                default:
                    throw new Error("unreachable");
            }
        }
    }

    /**
     * Visits a `while_statement`.
     * ```java
     *     while (true) { }
     * //  ^^^^^^^^^^^^^^^^
     * ```
     * ```
     * (while_statement condition: (parenthesized_expression) body: (block))
     * ```
     * @param {TreeSitterNode} node
     */
    visitWhileStmt(node) {
        const children = ddsa.getChildren(node);
        ignoreMutatingField(/* "condition" */);

        const bodyIdx = findFieldIndex(children, 1, "body");
        const body = children[bodyIdx];
        this.visitBlockStmt(body);
    }

    ///////////////////////////////////////////////////////////////////////////
    // Internal Bookkeeping
    ///////////////////////////////////////////////////////////////////////////

    /**
     * Finds the most recent assignment of the given identifier, if it exists.
     *
     * @param {string} name
     * @returns {NodeId | undefined}
     */
    lookupIdentifier(name) {
        // A current limitation of this is that it's not scope aware, and so we effectively always
        // read from a scope stack of height 1.
        return this.currentDefinition.get(name);
    }

    /**
     * Takes a {@link TreeSitterNode} out of {@link MethodFlow.lastTaintSource} (if it exists),
     * leaving `undefined` in its place.
     * @returns {TreeSitterNode | undefined}
     */
    takeLastTainted() {
        const last = this.lastTaintSource;
        this.lastTaintSource = undefined;
        return last;
    }

    /**
     * Marks the provided {@link TreeSitterNode} as the last tainted node.
     */
    markLastTainted(node) {
        this.lastTaintSource = node;
    }

    /**
     * Propagates taint from the {@link MethodFlow.lastTaintSource} (if it exists) to the target node.
     * @param {TreeSitterNode} target
     */
    propagateLastTaint(target) {
        const lastSource = this.lastTaintSource;
        if (lastSource === undefined) {
            return;
        }
        // Ignore comments (putting this check here allows each visitor to not have to explicitly handle comments).
        if (isCommentNode(target)) {
            return;
        }
        this.graph.addTypedEdge(target.id, lastSource.id, EDGE_DEPENDENCE);
        this.lastTaintSource = target;
    }



    /**
     * Marks the current definition of the variable according to the incremental abstract program state
     * that is built while traversing the CST.
     *
     * (The approach accuracy is subject to the caveats at the top of this document)
     * @param {TreeSitterNode} node
     */
    markCurrentDefinition(node) {
        if (node.cstType !== "identifier") {
            throw new Error("node must be an `identifier`");
        }
        this.currentDefinition.set(node.text, node.id);
    }
}

/**
 * Returns the index of the first node with a matching `fieldName`, or `-1` if it doesn't exist.
 *
 * @param {Array<TreeSitterFieldChildNode>} children
 * @param {number} start The index of `children` to start iterating from.
 * @param {string} fieldName The tree-sitter field name of the child.
 * @returns number
 */
function findFieldIndex(children, start, fieldName) {
    const len = children.length;
    for (let i = start; i < len; i++) {
        if (children[i].fieldName === fieldName) {
            return i;
        }
    }
    return -1;
}

/**
 * Returns `true` if the CST node is semantically a comment, or `false` if not.
 * @param {TreeSitterNode | TreeSitterFieldChildNode} node
 */
function isCommentNode(node) {
    switch (node.cstType) {
        case "block_comment":
        case "line_comment":
            return true;
        default:
            return false;
    }
}

/**
 * @typedef {0 | 1} BinExprOp
 * An integer representing the operator of a binary expression. Possible values:
 * * {@link BIN_EXPR_OP_IGNORED}
 * * {@link BIN_EXPR_OP_ADD}
 */

/** @type {0} */
export const BIN_EXPR_OP_IGNORED = 0;
/** @type {1} */
export const BIN_EXPR_OP_ADD = 1;

/**
 * A noop function intended for documentation:
 *
 * Technically a mutation can happen in this node via a function call, but we ignore it for simplicity because
 * we haven't implemented variable scopes.
 *
 * NB: While this function does not expect an argument to avoid runtime string allocation, the argument list
 * should contain a comment describing the field name of a node for documentation purposes, e.g.
 * ```js
 * ignoreMutatingField(
 *     // "exampleName"
 * );
 * ```
 */
function ignoreMutatingField() {
    // noop
}