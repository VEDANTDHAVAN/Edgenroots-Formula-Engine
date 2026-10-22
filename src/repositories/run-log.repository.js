async function insertMany(db, logs){
    if(!logs.length)return;
    const c=['run_uuid','formula_uuid','formula_version',
        'input_values','result','calculation_text',
        'status','error_message','skip_reason','duration_ms'];
    await db.execute(`INSERT INTO formula_run_logs (${c.join(',')}) VALUES ${logs.map(()=>`(${c.map(()=>'?').join(',')})`).join(',')}`,
    logs.flatMap(x=>[x.runUuid,x.formulaUuid,x.formulaVersion,JSON.stringify(x.input),x.result,x.calculation,x.status,x.error,x.skipReason,x.durationMs]));
}

module.exports={insertMany};
