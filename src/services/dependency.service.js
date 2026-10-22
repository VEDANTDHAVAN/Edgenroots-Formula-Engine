const helpers = new Set([
    'return','true','false','null',
    'undefined','if','else','while',
    'for','MATHS','LOGICAL','STRING',
    'EXTERNAL_VAR','SUM','ROUND',
    'AND','OR','IF'
]);

const identifiers = (text) => { 
    const scrub = text.replace(/(['\"])(?:\\.|(?!\1).)*\1/g, '')
    .replace(/EXTERNAL_VAR\s*\.\s*CODE\s*\.\s*[A-Za-z_$][\w$]*/g, ''); 
    
    return [...scrub.matchAll(/\b[A-Za-z_$][\w$]*\b/g)].map(
        x => x[0]).filter(x => !helpers.has(x) && !/^[A-Z_]+$/.test(x)
    ); 
};

const graph = (formulas) => { 
    const names = new Map(
        formulas.map(f => [f.name, f])
    ); 
    const deps = new Map(
        formulas.map(f => [f.name, identifiers(f.formula_text || f.formulaText).filter(n => names.has(n))])
    ); 
    
    return { names, deps }; 
};

function cyclePath(deps) { 
    const seen = new Set(), 
    stack = [], active = new Set(); 
    const visit = n => { 
        if (active.has(n)) return [...stack.slice(stack.indexOf(n)), n]; 
        if (seen.has(n)) return null; 
        seen.add(n); 
        active.add(n); 
        stack.push(n); 
        for (const d of deps.get(n) || []) { 
            const c = visit(d); if (c) return c; 
        } 
        stack.pop(); 
        active.delete(n); 
        
        return null; 
    }; 
    for (const n of deps.keys()) { 
        const c = visit(n); 
        if (c) return c; 
    } 
    return null; 
}

function order(formulas) { 
    const { deps } = graph(formulas); 
    const cycle = cyclePath(deps); 
    if (cycle) { 
        const e = new Error(`Circular dependency: ${cycle.join(' -> ')}`); 
        e.cycle = cycle; 
        throw e; 
    } 
    const left = new Map([...deps].map(([n,d]) => [n, new Set(d)])), levels=[]; while(left.size) { 
        const ready=[...left].filter(([,d])=>!d.size).map(([n])=>n); 
        if(!ready.length) throw new Error('Circular dependency'); 
        levels.push(ready); 
        ready.forEach(n=>left.delete(n)); 
        for(const d of left.values()) ready.forEach(n=>d.delete(n)); 
    } 
    return levels; 
}
const impacts = (formulas, name) => { 
    const { deps }=graph(formulas), 
    result=[], queue=[name], 
    seen=new Set(queue); 
    while(queue.length){
        const n=queue.shift(); 
        for(const [k,d] of deps) 
            if(d.includes(n)&&!seen.has(k)){
                seen.add(k); 
                result.push(k);
                queue.push(k);
            }
        } 
    return result; 
};

module.exports={ identifiers, graph, cyclePath, order, impacts };