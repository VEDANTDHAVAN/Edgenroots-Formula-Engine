const {z}=require('zod');
const identifier=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const create=z.object({
    uuid:z.string().uuid().optional(),
    name:identifier,formulaText:z.string().min(1).max(10000),
    expectedVersion:z.number().int().positive().optional(),
    createdBy:z.string().max(128).default('api')
});
const action=z.object({
    expectedVersion:z.number().int().positive(),
    force:z.boolean().default(false),
    createdBy:z.string().max(128).default('api')
});

module.exports={
    create, action, rollback: action.extend({
        version:z.number().int().positive().optional(),
        id:z.number().int().positive().optional()
    }).refine(
        x=>x.version||x.id
    )
};
