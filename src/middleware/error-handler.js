const { AppError } = require('../utils/errors');
module.exports = (err, req, res, next) => { 
    const known = err instanceof AppError; 
    if (!known) console.error(err); 
    res.status(known ? err.status : 500).json({ 
        error: { code: known ? err.code : 'INTERNAL_ERROR', message: known ? err.message : 'Unexpected server error', ...(known && err.details ? { details: err.details } : {}) }
    }); 
};
