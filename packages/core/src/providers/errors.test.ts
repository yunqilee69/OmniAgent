import { describe, expect, it } from 'vitest';
import { ProviderRequestError, agentErrorFromUnknown, providerRequestError } from './errors';

const gatewayBody = JSON.stringify({
  code: 'all_backends_unavailable',
  detail: [
    { model: 'cn:deepseek-v4.1-flash', status: 'cooldown', reason: '全部密钥冷却中' },
    { model: 'cn:deepseek-v4-flash', status: 'disabled', reason: '全部密钥已禁用' },
  ],
  message: "route 'deepseek-v4.1-flash' has no available backends",
  type: 'invalid_request_error',
});

describe('provider request errors', () => {
  it('keeps the HTTP status, code, message, and backend detail of a structured envelope', () => {
    const error = providerRequestError(`503: ${gatewayBody}`, 'fallback');
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({ status: 503, code: 'all_backends_unavailable', retryable: true });
    expect(error.message).toContain('HTTP 503');
    expect(error.message).toContain('all_backends_unavailable');
    expect(error.message).toContain("route 'deepseek-v4.1-flash' has no available backends");
    expect(error.message).toContain('cn:deepseek-v4.1-flash: cooldown (全部密钥冷却中)');
    expect(error.message.length).toBeLessThanOrEqual(500);
  });

  it('redacts credential-shaped text echoed by a provider', () => {
    const error = providerRequestError(
      '401: {"code":"invalid_api_key","message":"Incorrect API key provided: sk-live1234567890abcdef",'
        + '"type":"invalid_request_error"}',
      'fallback',
    );
    expect(error.message).toContain('invalid_api_key');
    expect(error.message).toContain('sk-***');
    expect(error.message).not.toContain('sk-live1234567890abcdef');
  });

  it('does not surface an unstructured body, but keeps its HTTP status', () => {
    const error = providerRequestError('502: upstream said Bearer supersecret-token', 'fallback');
    expect(error).toMatchObject({ status: 502, retryable: true });
    expect(error.message).toBe('HTTP 502');
    expect(error.message).not.toContain('supersecret');
  });

  it('does not mistake parenthesized status text inside the body for the real status', () => {
    const error = providerRequestError(
      '503: {"code":"overloaded","message":"upstream returned (404): missing"}',
      'fallback',
    );
    expect(error).toMatchObject({ status: 503, code: 'overloaded' });
    expect(error.message).toContain('HTTP 503');
    expect(error.message).toContain('upstream returned (404): missing');
  });

  it('accepts a provider label before the status', () => {
    const error = providerRequestError('Provider error (502): {"code":"bad_gateway"}', 'fallback');
    expect(error).toMatchObject({ status: 502, code: 'bad_gateway', retryable: true });
    expect(error.message).toBe('HTTP 502 · bad_gateway');
  });

  it('falls back when the provider gives no usable status or envelope', () => {
    const error = providerRequestError('socket hang up', 'pi-ai provider request failed');
    expect(error.message).toBe('pi-ai provider request failed');
    expect(error.status).toBeUndefined();
    expect(error.code).toBeUndefined();
    expect(error.retryable).toBe(false);
  });

  it('maps structured errors to the public agent contract and leaves other errors raw', () => {
    const structured = providerRequestError(`429: ${gatewayBody}`, 'fallback');
    expect(agentErrorFromUnknown(structured)).toEqual({
      message: structured.message,
      code: 'all_backends_unavailable',
      status: 429,
      retryable: true,
    });
    expect(agentErrorFromUnknown(new Error('private-token'))).toEqual({ message: 'private-token' });
  });
});
