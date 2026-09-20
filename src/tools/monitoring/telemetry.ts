/**
 * Forgevi 3.0 — OpenTelemetry wiring.
 *
 * Standard OTLP HTTP exporters (traces + metrics) when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise every call is a no-op
 * through the OpenTelemetry API's default global providers. Every agent
 * step, every tool call, every LLM round-trip and every browser preview
 * lands under one trace per run — the browser-as-preview-tool is
 * explicitly connected to telemetry (spans carry the URL, status and
 * screenshot size).
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { metrics, trace, type Span } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import { config } from "../../config.ts";

export const tracer = trace.getTracer("forgevi-3");

export const meter = metrics.getMeter("forgevi-3");

export const counters = {
  runs: meter.createCounter("forgevi_runs_total", { description: "runs started" }),
  steps: meter.createCounter("forgevi_steps_total", { description: "agent steps taken" }),
  toolCalls: meter.createCounter("forgevi_tool_calls_total", { description: "tool calls executed" }),
  tokens: meter.createCounter("forgevi_llm_tokens_total", { description: "LLM tokens billed (prompt + completion)" }),
};

let started = false;

export function initTelemetry(): void {
  if (started) return;
  started = true;
  if (!config.otlpEndpoint) {
    console.error("[telemetry] OTLP endpoint not set — spans/metrics are no-ops (honest, silent in the event stream)");
    return;
  }
  const traceExporter = new OTLPTraceExporter({
    url: `${config.otlpEndpoint.replace(/\/+$/, "")}/v1/traces`,
  });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": "forgevi-3",
      "service.version": "3.0.0",
    }),
    traceExporter,
  });
  sdk.start();
  console.error(`[telemetry] OTLP traces → ${config.otlpEndpoint}`);
}

/** Run fn inside a span; attrs recorded on start, result attrs on end. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) span.setAttribute(k, v);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.setStatus({
        code: 2, // ERROR
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Standard attribute names the OTel world already understands. */
export const semconv = SemanticAttributes;
