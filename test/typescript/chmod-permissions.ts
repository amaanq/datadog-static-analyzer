const fs = require('fs');
const fsPromises = fs.promises;

fs.chmodSync("/tmp/myfile", 0o777);
fsPromises.chmod("/tmp/fsPromises", 0o777);
