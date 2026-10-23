const { z } = require("zod");

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const input = z.record(z.string(), scalar);

const options = {
  formulaUuids: z.array(z.string().uuid()).max(100).optional(),
  asOf: z.string().datetime({ offset: true }).optional(),
};

const preview = z
  .object({
    input,
    ...options,
  })
  .strict();

const bulk = z
  .object({
    records: z.array(input).min(1).max(500),
    ...options,
  })
  .strict();

module.exports = { preview, bulk, input };
