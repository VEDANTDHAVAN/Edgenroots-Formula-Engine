const r=require('express').Router(),
c=require('../controllers/formula.controller');

r.post('/',c.create);
r.post('/preview/bulk',c.bulk);
r.post('/preview',c.preview);
r.post('/:uuid/deactivate',c.deactivate);
r.post('/:uuid/rollback',c.rollback);
r.get('/:uuid/history',c.history);
r.get('/:uuid/impact',c.impact);
r.get('/',c.list);

module.exports=r;
