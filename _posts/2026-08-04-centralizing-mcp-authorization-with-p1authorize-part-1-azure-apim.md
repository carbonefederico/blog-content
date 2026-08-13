---
title: Centralizing MCP Authorization with PingOne Authorize - Part 1
description: How to centralize dynamic authorization for MCP servers exposed by Azure APIM.
date: '2026-08-04'
categories:
- AI
- Identity
- Architecture
mermaid: true
tags:
- MCP
- Azure APIM
- PingOne Authorize
- OAuth
- Authorization
layout: post
---

## Context

Large organizations often adopt multiple cloud platforms, modern AI services, and distributed applications, which leads to increasingly fragmented authorization. A single enterprise for example may expose MCPs through Azure, AWS, and on-premises servers.

Each platform introduces its own authorization mechanism, and over time, business rules become scattered across gateways, serverless functions, middleware, and application code. The result is duplicated policies, inconsistent decisions, difficult audits, and expensive maintenance.

PingOne Authorize addresses this problem by separating **policy enforcement** from **policy decision making**. Gateways and applications remain responsible for enforcing decisions as Policy Enforcement Points (PEPs), while PingOne Authorize acts as the centralized no-code Policy Decision Point (PDP).

This is the first article in a series exploring how PingOne Authorize can centralize authorization decisions across different platforms and MCP environments.

I start with **Azure API Management (APIM)** protecting an MCP server, while future articles will apply the same model to other enforcement points such as AWS AgentCore Gateway.

## What Problem PingOne Authorize solves: Sprawl Across Hybrid Environments

As enterprises expand across cloud providers and AI platforms, these challenges emerge.

- **Inconsistent authorization** — Business policies become embedded in platform-specific implementations. The same rule may be implemented differently across gateways, clouds, and applications, producing inconsistent decisions.
- **Policy duplication** — Authorization logic is copied into multiple enforcement points. Every policy change must then be implemented several times, increasing the risk of drift.
- **Authorization logic in code** — Without a dedicated policy engine, teams implement authorization rules directly in application code or middleware. This consumes development cycles and ties every policy change to code reviews, testing, and deployments.
- **Limited governance** — Authorization decisions are distributed across platform-specific logs, making it harder to understand why access was granted or denied and increasing the effort required for auditing and compliance.

PingOne Authorize solves those challenges by centralizing **policy evaluation**: it evaluates the business policy and returns the authorization decision. This allows organizations to:

- keep business authorization rules outside applications and MCP servers
- update policies without redeploying APIs
- use contextual and attribute-based authorization
- centralize authorization decisions and audit information
- reuse the same authorization model across different platforms
- gain visibility and improve auditability by logging every authorization decision

## The solution

The first implementation in this series protects a demo Customer MCP Server using Azure API Management. I will present how APIM can be extended via an APIM Policy Fragment that extracts the MCP call details, calls PingOne Authorize for a policy decision and returns a decision (PERMIT/DENY) to APIM, which enforces it. 

The following diagram depicts the components in the implementation and their interactions.

```mermaid
%%{init: {'flowchart': {'curve': 'linear'}}}%%
flowchart LR
    C["Agent"]
    MCP["Protected MCP"]

    subgraph AZURE["Azure APIM"]
        APIM["Azure API Management\nMCP endpoint"]
        FRAG["APIM Policy Fragment"]
    end

    subgraph PING["PingOne"]
        P1AZ["PingOne Authorize\nDecision Endpoint"]
    end

    C -->|"MCP tools/call\n(Agent Access Token - delegated)"| APIM
    APIM --> FRAG
    FRAG -->|"Tool Calls \n(MCP, Tool, Tool Arguments, APIM Token)"| P1AZ
    P1AZ -->|"PERMIT / DENY"| FRAG
    FRAG --> APIM
    APIM -->|"tools/call if PERMIT \n(JSON/RPC payload, Backend Access Token)"| MCP
```

- **Agent** — invokes MCP tools through APIM using an Agent Access Token (typically obtained via Token Exchange).
- **Azure API Management** — acts as the Policy Enforcement Point. Receives the MCP request, runs the policy fragment, and either forwards the call to the backend MCP or returns a 403.
- **APIM Policy Fragment** — a reusable APIM policy artifact that parses the MCP request, calls the PingOne Authorize decision endpoint, and enforces the returned decision. To call the decision endpoint it fetches its own PingOne token.
- **PingOne Authorize** — acts as the Policy Decision Point. Receives the authorization context and returns PERMIT or DENY.
- **Protected MCP** — the protected MCP server (in our context a demo Customer MCP), receives requests only after APIM allows them through.

The important boundary is that APIM does not contain the business authorization logic. It collects context, asks for a decision, and enforces the result.

> **Scope note:** This article focuses on the authorization integration between APIM and PingOne Authorize. Token validation, token exchange, and backend MCP server security are outside the scope of this article. In a production setup, APIM would exchange the inbound token for a backend-scoped token before calling the MCP server. For simplicity, the demo MCP server is left open and no token exchanges have been configured in APIM.

## The APIM Policy Fragment

The integration with PingOne Authorize is implemented directly as an APIM policy fragment. The fragment performs four operations:

1. Parse the MCP request.
2. Obtain an OAuth token that allows the policy fragment to call PingOne Authorize.
3. Call the PingOne Authorize Decision Endpoint.
4. Enforce the returned decision.


### 1. Parse the MCP Request

The first part reads the JSON-RPC body and preserves it so APIM can still forward the original request to the MCP server.

```xml
<set-variable
    name="mcp"
    value="@(context.Request.Body.As<JObject>(preserveContent:true))" />

<set-variable
    name="method"
    value="@((string)((JObject)context.Variables["mcp"])["method"])" />

<set-variable
    name="tool"
    value="@((string)((JObject)context.Variables["mcp"])["params"]?["name"])" />

<set-variable
    name="arguments"
    value="@(((JObject)context.Variables["mcp"])["params"]?["arguments"]?.ToString())" />

<set-variable
    name="requestId"
    value="@(((JObject)context.Variables["mcp"])["id"]?.ToString())" />

<set-variable name="incomingBearer" value="@{
    var auth = context.Request.Headers.GetValueOrDefault(
        &quot;Authorization&quot;,
        &quot;&quot;
    );

    return auth.StartsWith(
        &quot;Bearer &quot;,
        StringComparison.OrdinalIgnoreCase
    )
        ? auth.Substring(7)
        : &quot;&quot;;
}" />
```

APIM now has the method, tool name, arguments, request ID, and incoming bearer token available as policy variables.

### 2. Obtain a PingOne Access Token

To call the PingOne Authorize decision endpoint APIM obtains a PingOne token using OAuth 2.0 Client Credentials.

```xml
<send-request
    mode="new"
    response-variable-name="tokenResponse"
    timeout="20"
    ignore-error="false">

    <set-url>{{PingOneTokenUrl}}</set-url>
    <set-method>POST</set-method>

    <set-header name="Authorization" exists-action="override">
        <value>@{
            var clientId = "{{PingOneClientId}}";
            var clientSecret = "{{PingOneClientSecret}}";

            return "Basic " +
                Convert.ToBase64String(
                    System.Text.Encoding.UTF8.GetBytes(
                        clientId + ":" + clientSecret
                    )
                );
        }</value>
    </set-header>

    <set-header name="Content-Type" exists-action="override">
        <value>application/x-www-form-urlencoded</value>
    </set-header>

    <set-body>grant_type=client_credentials&amp;scope=openid</set-body>

</send-request>

<set-variable
    name="accessToken"
    value="@(
        (string)(
            (IResponse)context.Variables["tokenResponse"]
        ).Body.As<JObject>()["access_token"]
    )" />
```

This implementation requests a new token for every authorization call to make the flow easy to understand. In production, the token should be cached using APIM policies such as `cache-lookup-value` and `cache-store-value`, and refreshed shortly before expiration.

### 3. Call PingOne Authorize

APIM now sends the authorization context to the PingOne Authorize Decision Endpoint.

```xml
<send-request
    mode="new"
    response-variable-name="p1azResponse"
    timeout="20"
    ignore-error="false">

    <set-url>{{PingOneDecisionEndpoint}}</set-url>
    <set-method>POST</set-method>

    <set-header name="Authorization" exists-action="override">
        <value>@("Bearer " + (string)context.Variables["accessToken"])</value>
    </set-header>

    <set-header name="Content-Type" exists-action="override">
        <value>application/json</value>
    </set-header>

    <set-body>@{
        var parameters = new JObject();

        parameters["gateway.type"]        = "MS-APIM";
        parameters["gateway.service"]     = (string)context.Variables["pazService"];
        parameters["gateway.method"]      = (string)context.Variables["method"];
        parameters["gateway.bearerToken"] = (string)context.Variables["incomingBearer"];
        parameters["gateway.requestId"]   = (string)context.Variables["requestId"];

        var tool = (string)context.Variables["tool"];
        if (!string.IsNullOrEmpty(tool))
        {
            parameters["gateway.tool"] = tool;
        }

        var args = (string)context.Variables["arguments"];
        if (!string.IsNullOrEmpty(args))
        {
            var argsObj = JObject.Parse(args);
            foreach (var prop in argsObj.Properties())
            {
                parameters["gateway." + prop.Name] =
                    prop.Value.ToString();
            }
        }

        return new JObject(
            new JProperty("parameters", parameters)
        ).ToString();
    }</set-body>

</send-request>
```


For an MCP request such as:

```json
{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
        "name": "get_customer",
        "arguments": {
            "customerId": "CUST-10001"
        }
    }
}
```

The payload sent to PingOne Authorize looks like:

```json
{
  "parameters": {
    "gateway.type": "MS-APIM",
    "gateway.service": "customer-mcp",
    "gateway.method": "tools/call",
    "gateway.bearerToken": "<incoming-access-token>",
    "gateway.requestId": "2",
    "gateway.tool": "get_customer",
    "gateway.customerId": "CUST-10001"
  }
}
```
### 4. Enforce the Decision

The final section reads the response from PingOne Authorize.

```xml
<set-variable
    name="p1az"
    value="@(
        ((IResponse)context.Variables["p1azResponse"])
            .Body.As<JObject>()
    )" />

<set-variable
    name="decision"
    value="@(
        (string)(
            (JObject)context.Variables["p1az"]
        )["decision"]
    )" />
```

If the decision is `PERMIT`, APIM continues processing the request and forwards it to the MCP server. Anything else is treated as a denial.

```xml
<choose>
    <when condition="@(
        !&quot;PERMIT&quot;.Equals(
            (string)context.Variables[&quot;decision&quot;],
            StringComparison.OrdinalIgnoreCase
        )
    )">

        <set-variable name="errorCode" value="@{
            var body = (JObject)context.Variables["p1az"];
            var statements = body["statements"] as JArray;

            if (statements == null || statements.Count == 0)
            {
                return "access-denied";
            }

            return (string)statements[0]["code"] ?? "access-denied";
        }" />

        <set-variable name="errorMessage" value="@{
            var body = (JObject)context.Variables["p1az"];
            var statements = body["statements"] as JArray;

            if (statements == null || statements.Count == 0)
            {
                return "Access denied";
            }

            return (string)statements[0]["payload"] ?? "Access denied";
        }" />

        <return-response>
            <set-status code="403" reason="Forbidden" />

            <set-header name="Content-Type" exists-action="override">
                <value>application/json</value>
            </set-header>

            <set-body>@{
                return new JObject(
                    new JProperty(
                        "error",
                        new JObject(
                            new JProperty(
                                "code",
                                (string)context.Variables["errorCode"]
                            ),
                            new JProperty(
                                "message",
                                (string)context.Variables["errorMessage"]
                            )
                        )
                    )
                ).ToString();
            }</set-body>

        </return-response>

    </when>
</choose>
```

## Policies

The inbound token is obtained by the agent via token exchange. It carries both a subject (the human principal) and an actor (the agent acting on their behalf):

```json
{
  "iss": "https://auth.pingone.com/{envId}/as",
  "aud": "customer-mcp",
  "sub": "user-123",
  "act": {
    "sub": "agent-001"
  },
  "scope": "customers:mcp:read_users",
  "role": "advisor"
}
```

PingOne Authorize uses the inbound `gateway.service` parameter to identify the policy set to apply and evaluates the following:

1. **Token validity** — validates the token signature and checks expiration.
2. **Issuer check** — `gateway.bearerToken.iss` must match the expected PingOne issuer.
3. **Audience check** — `gateway.bearerToken.aud` must include the expected service audience (`customer-mcp`).
4. **Scope check** — `gateway.bearerToken.scope` must include the scope required for the called tool.
5. **Actor authorization** — `gateway.bearerToken.act.sub` (the agent) must be permitted to invoke the tool.
6. **Subject authorization** — `gateway.bearerToken.sub` (the user) must hold a role that permits the tool call (for example, `customer_agent` for `get_customer`). In this example we use the concept of a role, but any further logic can be implemented (attribute-based, entitlements lookup, etc.)
7. **Business logic** — additional attribute-based or dynamic rules, such as risk thresholds, entitlement lookups or payload analysis and thresholds.

The following picture shows what such a policy looks like in the PingOne Authorize policy designer.
![PingOne Authorize policy — showing the rule set described above enforced for the customer-mcp service](/assets/img/pingone-authorize-policy-customer-mcp.png)

The following two pictures show how the PingOne Authorize Decision Visualizer depicts its decisioning process. The first shows a PERMIT evaluation; the second shows a DENY due to an invalid actor subject.
![PingOne Authorize decision outcome — showing PERMIT with resolved attributes and statement details](/assets/img/pingone-authorize-policy-evaluation-success.png)

![PingOne Authorize decision outcome — showing DENY with resolved attributes and statement details](/assets/img/pingone-authorize-policy-evaluation-denied.png)


## Key Takeaways

This article explained how PingOne Authorize provides centralized dynamic authorization for Azure API Management. APIM acts as a Policy Enforcement Point for MCP servers without embedding business authorization rules in the gateway or in the protected MCP servers themselves. The policy fragment is the only integration artifact needed.

This pattern is most useful when:

- Multiple teams or platforms maintain separate authorization policies that express the same business rules, making drift and inconsistency inevitable.
- Policy changes require coordinated redeployments across gateways, functions, or application code.
- Compliance or audit requirements need a centralized, queryable record of every authorization decision regardless of where it was enforced.
- Authorization rules depend on contextual or dynamic attributes — user roles, risk scores, time constraints — that must evolve independently of the applications that enforce them.


The next articles will apply the same pattern to additional enforcement surfaces such as AWS API Gateway, further showing how authorization decisions can be centralized and standardized across platforms.

---

**Resources**

- [PingOne Authorize](https://docs.pingidentity.com/pingone/authorization_using_pingone_authorize/p1az_overview.html){:target="_blank"} — PingOne Authorize product documentation.
- [Azure API Management policies](https://learn.microsoft.com/en-us/azure/api-management/api-management-policies){:target="_blank"} — reference for APIM inbound policy expressions and `send-request`.
- [Source code](https://github.com/carbonefederico/ai-mcp-gateways-paz-integrations) — APIM policy fragment and configuration guidelines.

