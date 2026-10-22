const { randomUUID } = require('crypto'); 
const { AppError } = require('../utils/errors');
const columns=['uuid','name','formula_text','status','created_by','first_created_at','version'];
async function saveRecord(connection, data) { 
    const rows=Array.isArray(data)?data:[data]; 
    if(!rows.length)return []; 
    const out=[]; 
    for(const input of rows){
        const uuid=input.uuid||randomUUID(); 
        let current={}; 
        if(input.uuid){
            const [found]=await connection.execute('SELECT * FROM current_formulas WHERE uuid=?',[uuid]); 
            if(!found[0])throw new AppError(404,'NOT_FOUND','Formula not found'); 
            current=found[0];
        } 
        const bad=Object.keys(input).filter(k=>!['uuid','name','formula_text','status','created_by','expectedVersion'].includes(k));
        if(bad.length)throw new AppError(400,'VALIDATION_ERROR','Invalid fields',{fields:bad}); 
        out.push({...current,...input,uuid,
            status:input.status||current.status||'ACTIVE',
            created_by:input.created_by||current.created_by||'api',
            first_created_at:current.first_created_at||new Date(),
            version:current.version?current.version+1:1});
    } 
    const sql=`INSERT INTO formulas (${columns.join(',')}) VALUES ${out.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',')}`;
    const [r]=await connection.execute(sql,out.flatMap(x=>columns.map(c=>x[c])));
    
    return out.map((x,i)=>({...x,id:r.insertId+i})); 
}

module.exports={saveRecord};
