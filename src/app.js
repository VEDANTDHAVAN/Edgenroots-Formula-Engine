const express=require('express'),
env=require('./config/env');

const app=express();

app.use(express.json({limit:env.bodyLimit}));
app.use('/formulas',require('./routes/formula.routes'));
app.use(require('./middleware/error-handler'));

module.exports=app;