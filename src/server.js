const app=require('./app'),
{port}=require('./config/env');

app.listen(port,()=>console.log(`Formula engine listening on ${port}`));
