class AppError extends Error {
    constructor(status, code, message, details) { 
        super(message); 
        this.status = status; 
        this.code = code; 
        this.details = details; 
    } 
}
const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);

module.exports = { AppError, badRequest };