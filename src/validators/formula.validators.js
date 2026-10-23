const { z } = require("zod");

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be a valid identifier");

const uuid = z.string().uuid();
const expectedVersion = z.number().int().positive();
const createdBy = z.string().min(1).max(128).default("api");

const create = z
  .object({
    uuid: uuid.optional(),
    name: identifier,
    formulaText: z.string().min(1).max(10000),
    expectedVersion: expectedVersion.optional(),
    createdBy,
  })
  .strict();

const action = z
  .object({
    expectedVersion,
    force: z.boolean().default(false),
    createdBy,
  })
  .strict();

const rollback = action
  .extend({
    version: z.number().int().positive().optional(),
    id: z.number().int().positive().optional(),
  })
  .refine((value) => value.version !== undefined || value.id !== undefined, {
    message: "Provide the version (or id) to restore",
    path: ["version"],
  });

const listQuery = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();

module.exports = { create, action, rollback, listQuery, identifier };
