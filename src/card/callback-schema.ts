export type CallbackSchema =
  | { type: 'object'; properties: Record<string, CallbackSchema>; required: string[] }
  | { type: 'string'; enum?: string[]; maxLength: number }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: CallbackSchema; maxItems: number };

const RESERVED = new Set(['__bridge_cb', 'callback_id', 'bridge_token', 'cmd', '__proto__', 'constructor', 'prototype']);

export function parseCallbackSchema(value: unknown, depth = 0): CallbackSchema {
  if (!isObject(value) || depth > 5) throw new Error('回调 schema 无效或嵌套过深');
  if (value.type === 'string') {
    checkKeys(value, ['type', 'enum', 'maxLength']);
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.every((v) => typeof v === 'string'))) {
      throw new Error('schema.enum 必须是字符串数组');
    }
    return { type: 'string', maxLength: boundedInteger(value.maxLength, 4096, 4096), ...(value.enum ? { enum: value.enum as string[] } : {}) };
  }
  if (value.type === 'number' || value.type === 'integer') {
    checkKeys(value, ['type', 'minimum', 'maximum']);
    for (const bound of [value.minimum, value.maximum]) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) throw new Error('数值 schema 的边界必须是有限数值');
    }
    const minimum = value.minimum as number | undefined;
    const maximum = value.maximum as number | undefined;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error('minimum 不得大于 maximum');
    return { type: value.type, minimum, maximum };
  }
  if (value.type === 'boolean') {
    checkKeys(value, ['type']);
    return { type: 'boolean' };
  }
  if (value.type === 'array') {
    checkKeys(value, ['type', 'items', 'maxItems']);
    return { type: 'array', items: parseCallbackSchema(value.items, depth + 1), maxItems: boundedInteger(value.maxItems, 32, 32) };
  }
  if (value.type !== 'object' || !isObject(value.properties)) throw new Error('对象 schema 必须声明 properties');
  checkKeys(value, ['type', 'properties', 'required', 'additionalProperties']);
  if (Object.keys(value.properties).length > 64) throw new Error('schema 字段过多');
  if (value.additionalProperties !== undefined && value.additionalProperties !== false) {
    throw new Error('回调 schema 不允许额外字段');
  }
  const properties: Record<string, CallbackSchema> = {};
  for (const [key, field] of Object.entries(value.properties)) {
    if (!key || key.length > 100 || RESERVED.has(key)) throw new Error(`schema 字段不可使用保留名称或无效名称：${key}`);
    properties[key] = parseCallbackSchema(field, depth + 1);
  }
  const required = value.required ?? [];
  if (!Array.isArray(required) || !required.every((key) => typeof key === 'string' && Object.hasOwn(properties, key))) {
    throw new Error('schema.required 必须引用已声明字段');
  }
  return { type: 'object', properties, required: required as string[] };
}

export function matchesCallbackSchema(schema: CallbackSchema, value: unknown): boolean {
  if (schema.type === 'string') {
    return typeof value === 'string' && value.length <= schema.maxLength && (!schema.enum || schema.enum.includes(value));
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum);
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems && value.every((item) => matchesCallbackSchema(schema.items, item));
  if (schema.type !== 'object' || !isObject(value)) return false;
  const properties = schema.properties;
  return schema.required.every((key) => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, field]) => Object.hasOwn(properties, key) && matchesCallbackSchema(properties[key]!, field));
}

function checkKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('回调 schema 含有不支持的规则');
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) throw new Error('schema 大小上限无效');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
