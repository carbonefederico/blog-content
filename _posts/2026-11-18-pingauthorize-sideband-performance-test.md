---
title: Measuring PingAuthorize performance for MCP decisions
description: A load-test of the PingAuthorize Sideband API decision path — one authorization decision per MCP tool call against a two-pod PingAuthorize cluster on Kubernetes
date: '2026-11-18'
categories:
- AI
- Identity
- Architecture
mermaid: true
tags:
- PingAuthorize
- Authorization
- Sideband API
- Performance
- Kubernetes
- k6
layout: post
---

## Context

Centralizing authorization in a policy decision point provides benefits for MCP gateways and agentic architectures. I described it in earlier posts on [centralizing MCP authorization with PingAuthorize]({{ '/posts/centralizing-mcp-authorization-with-p1authorize-part-1-azure-apim/' | relative_url }}) and on [agent-side enforcement with AgentGateway]({{ '/posts/centralizing-mcp-authorization-with-p1authorize-part-2-agentgateway/' | relative_url }}).

Every proxied tool call makes an extra hop to the policy engine, and a chatty agent multiplies that hop many times per conversation. This has a performance cost, that I measured with this setup: k6 agent Pods playing the gateway's role, calling PingAuthorize's [Sideband API](https://docs.pingidentity.com/pingauthorize/11.1/pingauthorize_server_administration_guide/paz_about_sideband_api.html) with one authorization decision per call, against a two-pod PingAuthorize cluster on Kubernetes.

The campaign ran two scenarios: 

- Scenario 1: single policy set to authorize 1 MCP
- Scenario 2: 100 policy sets to authorize 100 MCPs. 

I stopped at 2000 decisions per second by choice: the goal was a representative baseline, not the saturation point, in a shared test environment.

**The result**: in a non-production cluster with small machines, I obtained a **p95 latency below 9 ms** at **1000 decisions per second with 100 MCP servers configured** — and at **1500 decisions per second** with a single MCP server.

## The scenario

In the production architecture, an API gateway calls PingAuthorize and enforces its decisions. This benchmark measures only that sideband hop: ten in-cluster k6 generators stand in for the gateway, calling two PingAuthorize replicas running in embedded-PDP mode with an immutable policy package. No gateway or MCP backend participates in the measured path. 

The benchmark protects the demo portfolio MCP server: four tools, each with its own authorization policy level, from simple session gates to an approval-bound order path. 

The gateway, the agents, and PingAuthorize share one Kubernetes environment, so the measured path is the expected production service-to-service path; external ingress and the gateway's own processing are out of scope. 


```mermaid
%%{init: {'flowchart': {'curve': 'linear'}}}%%
flowchart TB
    subgraph CL["Shared Kubernetes cluster — 6 nodes, r5.xlarge"]
        direction TB

        subgraph LB["Load generation"]
            K1["k6 agent-0"]
            K2["k6 agent-1"]
            KM["…"]
            K9["k6 agent-9"]
            JB["Kubernetes Job<br/>10 indexed completions"]
        end

        subgraph PAZ["PingAuthorize — 2 StatefulSet Pods, embedded PDP"]
            P1["paz-0<br/>2 CPU req / 4 CPU lim"]
            P2["paz-1<br/>2 CPU req / 4 CPU lim"]
            SVC["Kubernetes Service<br/>cluster-internal HTTPS"]
        end

        JWKS["jwks Pod<br/>nginx, serves subject-key JWKS"]
        PAP["PAP Pod<br/>policy authoring, idle during runs"]
    end

    S3["S3 bucket<br/>versioned package store"]

    JB --> K1 & K2 & KM & K9
    K1 & K2 & KM & K9 -->|"sideband decision<br/>POST /sideband/request"| SVC
    SVC --> P1 & P2
    P1 -.->|"JWKS fetch (cached)"| JWKS
    P2 -.->|"JWKS fetch (cached)"| JWKS
    PAP -.->|"publish package"| S3
    P1 & P2 -.->|"Download package - every 30s"| S3
```

- k6 agent Pods: the load generators sign a fresh self-contained JWT subject token at every iteration — no token is reused — and wrap it, with an MCP request body, in the sideband envelope. The ten Pods split the target rate evenly (a distribution guard fails the run if an agent's share drifts more than 5%) and each Pod runs four concurrent ramped-arrival scenarios, one per policy path.
- Kubernetes Service: load-balances across both PingAuthorize Pods over cluster-internal HTTPS; no ingress sits on the measured path.
- PingAuthorize: runs the measured path — JWT validation, policy evaluation, and the decision response.
- JWKS server: a small nginx Pod serving the subject-token verification JWKS; PingAuthorize fetches and caches it.
- PAP and S3: publish the immutable policy package into a versioned S3 bucket; the PingAuthorize Pods poll and load it without a restart, the same machinery a production S3-backed deployment runs. Neither is on the decision path.

Each decision is one `POST /sideband/request` carrying the sideband shared secret in a `PDG-TOKEN` header and an envelope that mirrors what a gateway adapter sends: HTTP method, URL, headers (including the subject token as a `Bearer` credential), source IP and port, and the raw MCP request body. PingAuthorize validates the subject token's signature, issuer, audience, and expiry, evaluates the request against the policy package, and answers.

The policies under test are for a demo portfolio MCP server from [the agentgateway integration article]({{ '/posts/centralizing-mcp-authorization-with-p1authorize-part-2-agentgateway/' | relative_url }}): four tools — two reads (`get_portfolio_summary`, `list_positions`), a simulation (`simulate_trade`), and one write, `submit_trade_order`. Six named policies evaluate the JWT's claims and the MCP request body:

- **Session Methods** — protocol-level calls (`initialize`, `tools/list`, `ping`) are allowed if the common gate rules are met and the token includes the `portfolio:read` scope.
- **Allow Read Tools** — the read tools are allowed if the common gate rules (see below) are met and the token includes the `portfolio:read` scope; the cheapest evaluation.
- **Deny Unpriceable Orders** — a `submit_trade_order` call with `amount ≤ 0` is denied with `unpriceable_order_denied`; absent amounts resolve to 0, so an unpriced order is always denied.
- **Allow Orders with HITL Approval** — a `submit_trade_order` call with `0 < amount ≤ 20,000` is allowed only if the common gate rules are met, the token includes the `portfolio:write` scope, and the approval mirror binds the token's transaction context to the payload; the most expensive evaluation.
- **Deny Oversized Orders** — `amount > 20,000` is denied with `order_above_limit`, regardless of any approval: approval cannot exceed the band.
- **Default Deny** — everything else.

The **common gate rules** sit inside the three permit policies:

- **Audience** — the token must be minted for the MCP-specific audience (the `/mcp/portfolio` resource URI, per RFC 8707). A token for the wrong resource is `invalid_token` → `401`.
- **Delegated-agent authorization** — the acting agent must equal the declared allow-list entry `customer_support_agent`. Any other actor is denied with `agent_identity_mismatch` → `403`.
- **User claim** — delegated access is reserved to VIP users (`sub_type == vip_user`); a standard user behind an agent is denied with `delegation_not_permitted`.

In the HITL policy the mirror sits behind those gates and the `portfolio:write` scope check: the token's transaction context must mirror the payload field by field (`tool`, `customerId`, `symbol`, `side`, `quantity`, `amount`) and its `txn` claim must match the transaction id in the payload. Without it, the order is denied with the machine-readable `approval_required` challenge. The 20,000 band boundary is a policy constant, tunable without touching a rule.

The mix also includes deliberate denials, and they are not "any deny": an expected denial must match its fixture's configured status code (details under *Scenario 1: test stages*).

I deliberately excluded: any gateway, adapter, or MCP backend on the measured path (the k6 Pods send the same bytes a gateway adapter would); the external-PDP mode, where every decision adds a PAP round-trip; and persistent-store work (the measured decisions evaluate the in-process package and touch no user store).

## Format of the decision requests

Every k6 iteration sends one decision with exactly this shape. The load generator signs the subject token with RS256:

```http
POST /sideband/request HTTP/1.1
Host: paz-pingauthorize:443
PDG-TOKEN: <sideband_shared_secret>
Content-Type: application/json

{
  "source_ip": "10.0.0.42",
  "source_port": "41207",
  "method": "POST",
  "url": "https://agentgateway.example.internal/mcp/portfolio",
  "http_version": "1.1",
  "headers": [
    {"content-type": "application/json"},
    {"accept": "application/json, text/event-stream"},
    {"authorization": "Bearer eyJhbGciOiAiUlMyNTYiLCAidHlwIjogIkpXVCIs…[611 chars]"},
    {"host": "agentgateway.example.internal"}
  ],
  "body": "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"get_portfolio_summary\",\"arguments\":{\"customerId\":\"CUST-00042\",\"txn\":\"txn-17\"}},\"id\":17}"
}
```

The subject token's claims (decoded):

```json
{
  "iss": "https://paz-perf-subject",
  "sub": "vip-user-042",
  "sub_type": "vip_user",
  "client_id": "customer_support_agent",
  "aud": "https://agentgateway.example.internal/mcp/portfolio",
  "scope": "portfolio:read portfolio:write",
  "act": { "sub": "customer_support_agent" },
  "iat": 1763420160,
  "exp": 1763420460,
  "jti": "run-3-7-22-mix_read-17-1763420160"
}
```
A permit and a denial are both HTTP 200 at the sideband level. `sub` rotates through 100 synthetic VIP users, `act.sub` is the delegated agent identity the ladder gates on, `aud` is the MCP resource the audience rule checks, and the `jti` composition guarantees no two requests in the campaign ever carried the same token.

A permit is an HTTP 200 with **no** embedded response object; the gateway forwards the request:

```json
{}
```

A denial — here the oversized-order fixture — is also an HTTP 200, but carries the response the gateway must return to the client:

```json
{
  "response": {
    "response_code": 403,
    "body": "{\"status\":403,\"message\":\"order_above_limit\",\"detail\":\"Trade orders above the approval threshold are denied; approval cannot exceed the authorized band\"}"
  }
}
```

The gateway relays that embedded body to the client verbatim, so the denial carries a machine-readable `message` plus a human-readable `detail` — the same shape for all six deny paths, with `invalid_token` → 401 on token-validation failures. The example above shows the fields the policies configure; a live decision may also carry headers (for example `WWW-Authenticate`) and the code can arrive string-serialized (`"403"`), both of which the benchmark normalizes before comparing.

## The scenarios

The campaign ran two scenarios on the same deployment. **Scenario 1 — scalability**: one policy set authorizing one MCP server, with the load raised along a full ladder from 500 to 2000 decisions per second, measuring how the decision path scales with load. **Scenario 2 — policy-count impact**: 100 policy sets authorizing 100 MCP servers, held at the 1000 decisions per second reference level, measuring what adding policies to the tree costs when the load stays fixed.

## Test environment and sizing

Both scenarios run on the same environment: a shared Kubernetes cluster of six worker nodes, all r5.xlarge (4 vCPU and 32 GiB each).

**PingAuthorize sizing**

| Pod | CPU request | CPU limit | Memory request | Memory limit |
|---|---:|---:|---:|---:|
| paz (2) | 2 | 4 | 3 Gi | 6 Gi |

The scheduler places the two Pods on different nodes, an anti-affinity term keeps every k6 agent off them, and PAP (1 CPU request / 2 CPU limit) is idle during runs.

**Load generation**: 10 k6 Pods requesting 500m each, up to 200 arrivals per second per agent at the top stage.

## Scenario 1: test stages

The campaign ran four reference stages — 500, 1000, 1500, and 2000 decisions per second — and repeated the ascending ladder three times against the same continuously warmed deployment. Each run lasts five and a half minutes per scenario: 30 seconds ramping 0→full rate, then five minutes at the plateau; the published tables pool the whole run, ramp included. A throwaway sanity run at 50/s precedes the campaign to prove the collection path and warm the Pods; it is never counted.

**The traffic mix.** Each agent splits its rate share across the four policy paths, so every measured window exercises the whole ladder instead of only the cheapest path:

- **60% read permits** — `get_portfolio_summary` calls on the Allow Read Tools ladder.
- **15% session methods** — `initialize`/`tools/list`/`ping` calls on the Session Methods ladder.
- **15% HITL orders** — `submit_trade_order` calls with a 3,000 order inside the approval band, the token carrying the synthetic approval binding mirrored to the order body (no human approval workflow is exercised).
- **10% expected denials** — rotating through four negative fixtures: an undeclared acting agent and a token without `act.sub` (both → `agent_identity_mismatch` 403), an oversized 50,000 order (→ `order_above_limit` 403), and a wrong-audience token (→ `invalid_token` 401).

## Scenario 1: How the test is run

Four scripts drive everything, run from the client machine (my laptop): Deployment, Verification, Run test (the load test and result collection); and Reporting (the dashboard). Monitoring scripts sample Pod and node resource usage alongside. None of them are part of the measured path; they only observe the cluster through `kubectl` and collect results.

During a run:

- 10 k6 Pods start firing sideband decisions at PingAuthorize — 30 seconds of ramp, then five minutes at the plateau. While each Pod works, k6 records every request it makes — timestamp, duration, scenario, phase — into an NDJSON file inside its own container, and classifies every response in-flight: permit, expected denial with its expected code, or error.
- The five minutes end. Each k6 writes a structured end-of-run summary and an exit-code sentinel, then quits.
- The runner collects the per-request stream and the structured summary from each container and records the exit codes. 
- The reporting script reads only structured evidence, never logs, and merges it into one HTML dashboard on a shared time axis — the source of every number in this article. 

### Scenario 1: Results

Across the twelve counted runs of Scenario 1 (4 stages × 3 rounds) I saw 4,724,508 decisions, 100% expected outcomes, zero classified errors, zero dropped iterations. Not one incorrect decision.

Latency is k6 HTTP request duration: sending, waiting, and receiving. It includes the in-cluster request/response path and excludes connection establishment and generator-side JWT signing. Figures pool all ten generators over each full run, including the 30-second ramp. For the selected 2000/s run, full-call elapsed latency, including connection setup, was 6.96 ms average, 27 ms p95, and 56 ms p99.

Median run of the three rounds per stage:

| Stage | Target rate | Requests | avg | median | p90 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 500/s | 500/s | 157,460 | 1.93 ms | 1.70 ms | 2.48 ms | 3.33 ms | 6.45 ms |
| 1000/s | 1000/s | 314,960 | 2.29 ms | 1.79 ms | 3.43 ms | 5.03 ms | 10.50 ms |
| 1500/s | 1500/s | 472,456 | 3.13 ms | 1.92 ms | 5.63 ms | 8.86 ms | 21.07 ms |
| 2000/s | 2000/s | 629,957 | 6.77 ms | 2.73 ms | 15.91 ms | 26.67 ms | 55.69 ms |

Each stage's reported row is the **median run of its three**, selected by measured p95; the per-run p95s were 500/s: 3.02/3.33/3.40 ms · 1000/s: 4.91/5.03/5.49 ms · 1500/s: 8.71/8.86/10.17 ms · 2000/s: 24.48/26.67/33.10 ms — the observed run-to-run spread.

Across the four levels, the median decision latency barely moves — 1.70 to 2.73 milliseconds through 4× the load — while the tail bends upward, p95 growing 8× from the 500/s stage to the 2000/s stage. The rising tail alongside higher CPU usage is consistent with contention or queueing.

### Scenario 1: Latency and CPU over time at 2000 decisions per second

Both charts below come from the selected 2000/s run, the median of the three rounds at that level. The first is the reporter's average-and-p90 latency-over-time series; the second sums the two PAZ replicas' aligned CPU samples from the same in-run sampler into one combined series.

p90 response time (in ms)
![p90 response time over time at the 2000-per-second stage, from the reporter's latency-over-time evidence. After the 30-second ramp, the p90 oscillates between roughly 6 and 25 milliseconds for the rest of the run, with brief spikes, and recovers from each of them.](/assets/img/paz-sideband-2000rps-p90.svg){: .img-fluid }

Combined CPU load of the two PingAuthorize Pods (in millicores)
![Combined CPU of both PingAuthorize Pods during the 2000-per-second stage, summing the two replicas' aligned 15-second CPU samples. Both Pods ramp together in the first 30 seconds and then hold steady at about 3.7 cores combined for the rest of the run.](/assets/img/paz-sideband-2000rps-paz-cpu.svg){: .img-fluid }

Combined CPU holds steady at about 3.7 cores for the rest of the run; the two replicas had sampled CPU medians of 1.79 and 1.94 cores, summing to 3.73 cores.

### Scenario 1: Resource consumption

CPU figures come from samples captured every 15 seconds over the whole run, including the ramp. Median run of the three rounds per stage:

| Stage | Mean of replica CPU medians | Sum of replica CPU medians |
|---:|---:|---:|
| 500/s | 0.43 cores | 0.87 cores |
| 1000/s | 0.88 cores | 1.76 cores |
| 1500/s | 1.37 cores | 2.74 cores |
| 2000/s | 1.87 cores | 3.73 cores |

At the highest stage, the mean of the replica CPU medians was roughly 47% of each pod's four-CPU limit. Sampled peak memory was roughly 1.5 GiB per pod across all stages. At the highest stage, the ten generators' sampled CPU medians summed to roughly 7.4 cores; their work includes fresh-token signing, request construction, and metric recording.

### Scenario 2: 100 MCP servers at 1000 decisions per second

The ladder measured a single MCP branch; a production gateway authorizes many. Scenario 2 repeated the 1000/s stage with 100 MCP servers configured in PingAuthorize: the policy tree grew from one branch to 100 — the original plus 99 generated clones of the same 6-policy branch, each targeted at its own service with its own minted audience constant — and the generator randomly spread the load at every request. The deployment uses Ping's documented service-dispatch shape: a parameterized sideband endpoint (`/mcp/{mcp}`) derives the target service from the request path, so each decision lands directly on its branch's policy set.

Median run of the three rounds at the 1000/s stage:

| Stage | Target rate | Requests | avg | median | p90 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1000/s, 100 MCPs | 1000/s | 314,963 | 3.66 ms | 2.66 ms | 5.95 ms | 8.72 ms | 18.41 ms |

Each stage's reported row is the **median run of its three**, selected by measured p95; the per-run p95s were 8.16/9.20/8.72 ms. All three warm runs scored 100% expected outcomes with zero errors and zero dropped iterations at an achieved rate of 954/s.

Tree size costs the median under a millisecond and the tail about 2.6 ms. CPU rose with the tree: the two replicas' sampled CPU medians summed to about 2.6 cores across the three warm runs (roughly 1.2 and 1.3 cores each), against 1.76 cores for the single-branch baseline at the same stage — about 0.85 cores more for evaluating 100 branches instead of one. Sampled peak memory stayed in the same band as every other stage, roughly 1.2–1.3 GiB per pod.

## Key takeaways

For this synthetic MCP workload, the selected median-p95 runs kept median HTTP latency below 3 ms at every tested target rate up to 2000/s with a single MCP server protected (Scenario 1). Adding 99 more MCP servers to the policy tree at a fixed 1000/s cost 0.87 ms of median and 3.7 ms of p95 (Scenario 2) — latency that stays well under 10 ms at the tail. These results describe the in-cluster sideband hop for this policy package and environment; they exclude gateway processing, backend execution, and the human approval workflow.

---

**Resources**

- [pingauthorize-sideband-perf](https://github.com/carbonefederico/pingauthorize-sideband-perf){:target="_blank"} — the benchmark source: Helm charts, k6 script, monitor and report tooling, and the twelve published HTML reports of the 3×4 campaign.
- [About the Sideband API](https://docs.pingidentity.com/pingauthorize/11.1/pingauthorize_server_administration_guide/paz_about_sideband_api.html){:target="_blank"} — the sideband deployment model and embedded vs external PDP modes.
- [Configuring embedded PDP mode](https://docs.pingidentity.com/pingauthorize/11.1/pingauthorize_server_administration_guide/paz_config_embedded_pdp.html){:target="_blank"} — deployment-package stores and the embedded Policy Decision Service.
- [Managing deployment packages](https://docs.pingidentity.com/pingauthorize/11.1/pingauthorize_policy_administration_guide/paz_managing_deployment_packages.html){:target="_blank"} — how policy state is versioned into immutable packages.
- [k6 documentation](https://grafana.com/docs/k6/latest/){:target="_blank"} — ramping-arrival-rate executor and thresholds.
- [Centralizing MCP authorization with PingAuthorize]({{ '/posts/centralizing-mcp-authorization-with-p1authorize-part-1-azure-apim/' | relative_url }}) — the architecture this test measures the cost of.
