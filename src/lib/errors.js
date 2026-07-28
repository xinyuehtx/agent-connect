'use strict';

/**
 * 领域错误：带 code 与 httpStatus，供 Web 路由统一映射。
 */
class DomainError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus || 400;
  }
}

class NotFoundError extends DomainError {
  constructor(message) { super('NOT_FOUND', message, 404); }
}

class NotControllableError extends DomainError {
  constructor(message) { super('NOT_CONTROLLABLE', message, 409); }
}

class ConflictError extends DomainError {
  constructor(message) { super('CONFLICT', message, 409); }
}

class UpstreamError extends DomainError {
  constructor(message) { super('UPSTREAM', message, 502); }
}

module.exports = {
  DomainError, NotFoundError, NotControllableError, ConflictError, UpstreamError,
};
