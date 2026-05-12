export function safeCloudflareArraySummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const categories = cloudflareResponseCategories(parsed);
      return JSON.stringify(categories.length > 0 ? { count: parsed.length, categories } : { count: parsed.length });
    }
  } catch {}
  return JSON.stringify({ count: null });
}

export function sanitizeCloudflareResponse(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return { non_object_response: true };
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (typeof input.success === "boolean") {
    output.success = input.success;
  }
  if (Array.isArray(input.errors)) {
    output.errors = input.errors.map(sanitizeCloudflareMessage);
  }
  if (Array.isArray(input.messages)) {
    output.messages = input.messages.map(sanitizeCloudflareMessage);
  }
  if (typeof input.result === "object" && input.result !== null) {
    const result = input.result as Record<string, unknown>;
    output.result = {
      delivered: summarizeCloudflareArray(result.delivered),
      queued: summarizeCloudflareArray(result.queued),
      permanent_bounces: summarizeCloudflareArray(result.permanent_bounces),
    };
  }
  return output;
}

export function cloudflareResponseCategories(items: unknown[]): string[] {
  const categories = new Set<string>();
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    for (const key of ["category", "reason", "status", "code", "error_code", "errorCode", "type"]) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number") {
        const category = String(value).trim().toLowerCase();
        if (/^[a-z0-9_.:-]{1,64}$/.test(category) && !category.includes("@")) {
          categories.add(category);
        }
      }
    }
  }
  return [...categories].sort();
}

function sanitizeCloudflareMessage(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const code = sanitizedCode(input.code);
  if (code !== null) {
    output.code = code;
  }
  const message = sanitizedMessage(input.message);
  if (message !== null) {
    output.message = message;
  }
  return output;
}

function summarizeCloudflareArray(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const categories = cloudflareResponseCategories(value);
  return categories.length > 0 ? { count: value.length, categories } : { count: value.length };
}

function sanitizedMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.includes("@")) {
    return null;
  }
  return normalized.slice(0, 256);
}

function sanitizedCode(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_.:-]{1,64}$/.test(normalized) && !normalized.includes("@") ? normalized : null;
}
