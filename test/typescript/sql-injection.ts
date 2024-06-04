var express = require('express')

var app = express()
const Sequelize = require('sequelize');
const sequelize = new Sequelize('database', 'username', 'password', {
  dialect: 'sqlite',
  storage: 'data/juiceshop.sqlite'
});

app.post('/login', function (req, res) {
    sequelize.query('SELECT * FROM Products WHERE name LIKE ' +  req.body.username);
  })


app.post('/update', function (req, res) {
    sequelize.query('UPDATE products SET bla=bli WHERE name LIKE ' +  req.body.username);
  })



app.post('/remove', function (req, res) {
    sequelize.query('DELETE FROM product WHERE name LIKE ' +  req.body.username);
  })