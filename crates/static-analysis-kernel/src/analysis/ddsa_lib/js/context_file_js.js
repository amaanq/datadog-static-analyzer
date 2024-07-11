// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License, Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2024 Datadog, Inc.

// {
//   "name": string
//   "importedFrom": string | null // if it's importing a module, this will be null
//   "importedAs": string | null // if it's aliased with `as`, this will be filled in
// }

const { op_get_js_imports } = Deno.core.ops;

/**
 * A JavaScript import, which may be a module, a function, a variable, or a type.
 *
 * @typedef {Object} PackageImport
 * @property {string} name - The name of the item being imported.
 * @property {string | null} importedFrom - The package that the item is being imported from. Note that this will be `null` if we are importing the module as a whole,
 *                                          instead of a specific item from the module.
 * @property {string | null} importedAs - The alias that the item is being imported as. Note that this will be `null` if we are not aliasing the import.
 */

export class PackageImport {
  /**
   * Creates a new `PackageImport`.
   *
   * @param {string} name
   * @param {string | null} importedFrom
   * @param {string | null} importedAs
   */
  constructor(name, importedFrom, importedAs) {
    this.name = name;
    this.importedFrom = importedFrom;
    this.importedAs = importedAs;
  }

  isAlias() {
    return this.importedAs !== null;
  }

  isModule() {
    return this.importedFrom === null;
  }
}

export class FileContextJavaScript {
  /**
   * Creates a new `FileContextJavaScript`
   *
   * @param {PackageImport[]} jsPackages
   */
  constructor(jsPackages) {
    this.jsPackages = jsPackages;
  }
}

/**
 * Returns all the packages that is imported in a `javascript` file
 *
 * @param {string} packageName
 *
 * @returns {boolean}
 */
export function jsImportsPackage(packageName) {
  const imports = op_get_js_imports(packageName);
  return imports.some((i) => i.importedFrom ? i.importedFrom === packageName : i.name === packageName);
}
