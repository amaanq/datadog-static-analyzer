var table = 'baz';

const foo = "SELECT foo FROM " + table;
const select = `SELECT foo FROM ${table}`;
var del = `DELETE FROM ${table} WHERE condition;`;
let update = ' UPDATE ' +
             table +
             "SET column1 = value1, column2 = value2" +
             "WHERE condition;";