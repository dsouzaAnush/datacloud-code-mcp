# Salesforce Data Cloud (Data 360) — Comprehensive Architecture & Implementation Guide

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Core Architecture](#2-core-architecture)
3. [Capability Deep Dives](#3-capability-deep-dives)
4. [Industry Reference Architectures](#4-industry-reference-architectures)
5. [DataKits — Packaging & Deployment](#5-datakits--packaging--deployment)
6. [Integration Patterns](#6-integration-patterns)
7. [Implementation Playbook](#7-implementation-playbook)
8. [Anti-Patterns & Gotchas](#8-anti-patterns--gotchas)

---

## 1. Platform Overview

Salesforce Data Cloud (rebranded **Data 360** in October 2025) is Salesforce's customer data platform built natively on the Einstein 1 Platform. It unifies customer data from any source — CRM, commerce, marketing, external systems — into a single harmonized profile, then makes that unified data actionable across the entire Salesforce ecosystem.

### Design Principles

Data Cloud is built around eight foundational principles:

1. **Metadata-driven architecture** — Everything is described by metadata (DMOs, mappings, relationships). This makes the platform extensible without custom code.
2. **Zero-copy data sharing** — Native connectors to Snowflake, BigQuery, Databricks, and Redshift allow querying external data in place without ingestion.
3. **Open data lakehouse** — Under the hood, Data Cloud stores data in Apache Iceberg format, making it accessible to external tools.
4. **Real-time + batch hybrid** — Supports streaming ingestion (< 10 min latency), rapid segments (1–4 hr), and standard batch processing (24 hr).
5. **Multi-tenant with data isolation** — Data Spaces provide logical partitioning for multi-brand, multi-region, or multi-tenant use cases.
6. **Declarative-first** — Most configuration is done through the UI or metadata APIs rather than imperative code.
7. **AI-native** — Einstein AI features (predictions, recommendations, generative AI) consume unified profiles directly.
8. **Governed by design** — Consent management, GDPR APIs, data space access controls, and audit trails are built in.

### Storage & Processing Layers

Data Cloud operates across three tiers:

- **Ingestion Layer** — Data Streams + Connectors bring data in. Supports Salesforce CRM Connector, MuleSoft, Marketing Cloud, Commerce Cloud, Interaction Studio, custom S3/GCS ingestion, and zero-copy federation.
- **Harmonization Layer** — Data Model Objects (DMOs) define the canonical schema. Field mappings align source fields to DMO fields. Identity Resolution merges records across sources into unified profiles.
- **Activation Layer** — Segments, Calculated Insights, Activations, and Data Actions push unified data back out to Marketing Cloud, Commerce Cloud, custom webhooks, advertising platforms, and more.

---

## 2. Core Architecture

### Data Model Objects (DMOs)

DMOs are the canonical data model — the single schema that all ingested data gets mapped into. Data Cloud ships with a standard data model based on common entities (Individual, Account, Sales Order, Engagement, etc.), but custom DMOs can be created for industry-specific or organization-specific needs.

Key concepts:

- **Standard DMOs** come pre-built (e.g., `Individual__dlm`, `SalesOrder__dlm`, `UnifiedIndividual__dlm`). Use them when they fit your use case to leverage pre-built identity resolution and segmentation.
- **Custom DMOs** are created when standard ones don't cover your domain. They require explicit field definitions and relationship mappings.
- **Object Categories**: `Profile` (person-level), `Engagement` (events/interactions), `Other` (reference/lookup data).
- **Relationships** link DMOs together (e.g., SalesOrder → Individual). These are critical for segmentation across related entities and for Data Graph queries.

### Data Streams & Connectors

A **Connector** defines the connection to a source system (credentials, endpoint). A **Data Stream** defines what data flows from a connector into which DMO, with field-level mappings.

**Important**: The CDP `/ssot/connections` API requires a `connectorType` URL parameter for all operations (list, get, create, update, delete, test). Use the `d360_connector_list` tool to discover valid values (e.g., `SalesforceCRM`, `TenantBillingUsageConnector`, `S3`, `MarketingCloud`).

Ingestion modes:

- **Full refresh** — Replaces all data on each run. Use for small reference tables.
- **Incremental (upsert)** — Only new/changed records. Requires a primary key. Use for transactional data.
- **Streaming** — Near-real-time via the Ingestion API. Use for clickstream, IoT signals, or event-driven architectures.

### Field Mappings

Each Data Stream maps source fields to DMO fields. Mappings can include:

- **Direct mappings** (source field → DMO field)
- **Formula mappings** (transform during ingestion)
- **Constant mappings** (hardcoded values, useful for source identifiers)

#### Smart Field Matching

The MCP server provides `d360_smart_mapping` which auto-generates field mappings by inspecting both DLO and DMO fields. It uses:
- **Normalization**: Strips `__c`, `__dlm`, `__dll`, `ssot__` prefixes
- **Tokenization**: Splits camelCase and underscore-separated names
- **Jaccard similarity**: Compares token overlap between field names
- **Label matching**: Uses display labels when available (often more descriptive)
- **Data type compatibility**: Boosts score when types match

This significantly reduces manual mapping effort and catches non-obvious matches. Use `d360_preview_field_matches` for a dry-run before committing.

#### Event Date Column Selection

For Engagement category data streams, an `eventDateColumn` must be set to an **immutable** date field. The MCP server's `d360_smart_datastream` tool auto-selects the best candidate:

- **Preferred** (score 80-100): `CreatedDate`, `EventDate`, `ActivityDate`, `OccurredDate`
- **Acceptable** (score 60-80): `StartDate`, `SentDate`, `CloseDate`
- **Excluded**: `LastModifiedDate`, `SystemModstamp` (mutable — change on updates, breaks time-series partitioning)

### Identity Resolution

Identity Resolution (IR) is one of Data Cloud's most powerful and complex capabilities. It takes records from multiple DMOs and merges them into `UnifiedIndividual__dlm` or `UnifiedAccount__dlm` profiles.

#### Match Rules

IR supports three match types, evaluated in order of precedence:

1. **Exact Match** — Field values must be identical (case-insensitive). Best for email, phone, loyalty ID. Fastest and most reliable.
2. **Normalized Match** — Values are cleaned before comparison (whitespace, formatting, common abbreviations). Good for names and addresses.
3. **Fuzzy Match** — Uses algorithms (edit distance, phonetic) to find approximate matches. Most flexible but highest false-positive risk.

Each rule specifies:
- Source DMO and field
- Match type
- Confidence threshold (for fuzzy)
- Whether to use as a primary or secondary rule

#### Reconciliation Rules

After matching identifies which records belong to the same person, reconciliation determines which field values "win" for the unified profile:

- **Most Recent** — Latest timestamp wins. Best for contact info (email, phone, address).
- **Source Priority** — A ranked list of sources determines which value wins. Best when you trust CRM over marketing data.
- **Most Frequent** — The value appearing most often wins. Good for demographic fields.
- **Manual Override** — Specific source + field combinations always win.

#### IR Gotchas

- IR runs on a schedule (not real-time). Plan for a 24-hour cycle for standard processing.
- Fuzzy matching can create "mega-clusters" — one match chain linking thousands of unrelated records. Set confidence thresholds conservatively (start at 85%+).
- IR rulesets cannot be tested in a sandbox with production-scale data. Use representative sample datasets.
- The `UnifiedIndividual__dlm` DMO is system-managed. You cannot add custom fields to it directly; use Calculated Insights instead.

### Calculated Insights (CIs)

CIs are computed aggregations that enrich unified profiles. They use a SQL-like syntax ("CI SQL") to define metrics that are materialized and attached to profiles.

#### CI SQL Patterns

```sql
-- Basic aggregation
SELECT
  IndividualId__c AS UnifiedIndividual__dlm.Id__c,
  COUNT(*) AS TotalOrders__c,
  SUM(TotalAmount__c) AS LifetimeValue__c,
  MAX(OrderDate__c) AS LastOrderDate__c
FROM SalesOrder__dlm
GROUP BY IndividualId__c
```

#### CI SQL Limitations

- **No COUNT(DISTINCT ...)** — Use a subquery with GROUP BY + COUNT(*) as a workaround.
- **No date arithmetic** — Cannot do `DATEDIFF()` or `CURRENT_DATE - field`. Compute date differences in a Data Transform first.
- **No CTEs (WITH clause)** — Flatten your queries or use nested subqueries.
- **No HAVING clause** — Filter after aggregation using a wrapper query.
- **Limited JOIN support** — Only implicit joins through DMO relationships are supported.
- **No window functions** — No `ROW_NUMBER()`, `RANK()`, `LAG()`, etc.

#### CI Lifecycle

1. Create the CI definition (name, SQL expression, dimensions, measurements).
2. **Validate** — Checks SQL syntax and field references.
3. **Enable** — Makes the CI active but doesn't run it.
4. **Run** — Executes the computation. Can be scheduled or triggered on-demand.
5. **Wait for completion** — Use the run status endpoint to poll until done.

CIs support scheduling (cron-based) for automated refresh.

### Segments

Segments define audiences based on unified profile attributes, CI metrics, and engagement data. They produce a list of `UnifiedIndividual__dlm` IDs that can be activated to downstream targets.

#### Segment Types

| Type | Refresh | Use Case |
|------|---------|----------|
| **Standard** | Every 24 hours | Campaign audiences, reporting |
| **Rapid** | Every 1–4 hours | Time-sensitive offers, event-driven |
| **Streaming** | Near real-time | Triggered journeys, real-time personalization |

#### Creating Segments via API

The segment definition uses a **DBT SQL** syntax (not regular SQL):

```sql
SELECT Id FROM UnifiedIndividual__dlm
WHERE ssot__LifetimeValue__c > 1000
AND ssot__LastEngagementDate__c > DATEADD(day, -90, CURRENT_DATE)
```

This is the `segmentDefinition` field in the API payload. The API also accepts publish schedule configuration for automated refresh.

#### Segment Gotchas

- Streaming segments require the Streaming Segments add-on license.
- Segment membership counts may take a full refresh cycle to stabilize after IR changes.
- The maximum number of active segments varies by edition (typically 50–200).
- Rapid segments consume more compute credits than standard ones.

### Data Transforms

Transforms allow you to create derived datasets by running SQL against ingested data. Think of them as materialized views.

Two types:

- **Batch Transforms** — Run on a schedule, process full datasets. Good for aggregations, denormalization, data quality cleansing.
- **Streaming Transforms** — Process data as it arrives. Good for real-time enrichment, filtering, format normalization.

Transform SQL is standard SQL with access to all DMOs in the Data Cloud instance. Results are written to a new DMO that can be used in segmentation, CIs, or activations.

### Semantic Data Models (SDMs)

SDMs provide a business-friendly analytics layer over Data Cloud's raw data. They define dimensions, measurements, calculated fields, and relationships that business users can query without knowing SQL.

#### SDM Components

- **Data Objects** — Map to underlying DMOs or Data Lake Objects. Define which fields are exposed.
- **Dimensions** — Categorical/grouping fields (e.g., Region, Product Category, Date).
- **Measurements** — Numeric fields that can be aggregated (e.g., Revenue, Quantity).
- **Calculated Dimensions** — Derived categorical fields using formulas (e.g., age brackets, fiscal quarters).
- **Calculated Measurements** — Derived metrics using formulas (e.g., average order value = Revenue / OrderCount).
- **Relationships** — Link data objects together for cross-object queries.
- **Metrics** — Pre-defined business KPIs with specific aggregation rules.

#### Semantic Query

The Semantic Query API (`/semantic-engine/gateway`) uses a structured JSON payload:

```json
{
  "query": {
    "semanticModelId": "<model-uuid>",
    "structuredSemanticQuery": {
      "fields": [
        {
          "expression": {
            "tableField": {
              "tableName": "DataObjectApiName",
              "name": "FieldApiName"
            }
          },
          "rowGrouping": true
        },
        {
          "expression": {
            "tableField": {
              "tableName": "DataObjectApiName",
              "name": "NumericFieldApiName"
            }
          },
          "semanticAggregationMethod": "SEMANTIC_AGGREGATION_METHOD_SUM"
        }
      ],
      "options": {
        "limitOptions": { "limit": 100 }
      }
    }
  }
}
```

Key points:
- Use `semanticModelId` (UUID from the list endpoint), NOT the API name.
- `rowGrouping: true` marks a field as a dimension (GROUP BY).
- Available aggregation methods: `_SUM`, `_COUNT`, `_AVG`, `_MIN`, `_MAX`.

### Activations

Activations push segment membership and profile data to external systems. An Activation consists of:

- **Activation Target** — The destination (Marketing Cloud, Google Ads, Meta, S3, webhook, etc.).
- **Activation** — Links a segment to a target with field mappings defining what data is sent.

Target types include Marketing Cloud, Ads (Google, Meta, TikTok, Snapchat), Cloud Storage (S3, GCS, Azure Blob), and Custom (webhook/API).

### Data Spaces

Data Spaces are logical partitions within a Data Cloud org. They control which data is visible and accessible to different teams, brands, or regions.

Use cases:

- **Multi-brand** — Brand A sees only Brand A customer data.
- **Regional compliance** — EU data space with GDPR-specific retention policies.
- **Department isolation** — Marketing sees engagement data; Finance sees transaction data.

Data Spaces control access to DMOs, segments, CIs, and activations. A DMO can be a "member" of multiple data spaces.

### Data Graphs

Data Graphs provide a pre-joined, denormalized view of related data centered on a root entity (typically UnifiedIndividual). They're optimized for:

- Profile API lookups (get all data about one person)
- Einstein AI features that need a complete customer context
- Action-oriented use cases that need fast, pre-computed relationships

### GDPR / Privacy

The GDPR APIs provide:

- **Right to Access** — Retrieve all data for a given individual.
- **Right to Erasure** — Delete all data for a given individual across all DMOs.
- **Bulk operations** — Process access/erasure requests in batch.

---

## 3. Capability Deep Dives

### Query APIs

Data Cloud offers multiple query interfaces:

| API | Use Case | Endpoint |
|-----|----------|----------|
| **CDP Query (v1)** | Simple SQL queries | `/ssot/query` |
| **CDP Query (v2)** | Paginated queries with metadata | `/ssot/queryv2` |
| **Query SQL** | Advanced queries with parameters, cancellation | `/ssot/query-sql` |
| **Semantic Query** | Business-friendly structured queries | `/semantic-engine/gateway` |
| **Profile Query** | Lookup individual profiles | `/ssot/profile` |
| **Insights Query** | Query CI results directly | `/ssot/insights` |
| **Data Graph Query** | Pre-joined entity lookups | `/ssot/data-graphs/{name}/query` |

**Query SQL** is the most powerful, supporting:
- SQL parameters (typed, with precision/scale)
- Adaptive timeouts
- Row limits
- Asynchronous execution with status polling
- Pagination across result chunks
- Query cancellation

### Events / Ingestion API

The Event APIs allow real-time data ingestion:

- **Single event publish** — Push one record at a time. Good for real-time triggers.
- **Batch event publish** — Push up to 1000 records. Good for micro-batch patterns.

Events are published to a specific schema (source object), which must have a corresponding Data Stream configured.

### Plan Execution

The Plan Execution API orchestrates multi-step data processing pipelines:
- Trigger data stream ingestion
- Run identity resolution
- Execute calculated insights
- Refresh segments

This is the "run everything" button for a full data refresh cycle.

---

## 4. Industry Reference Architectures

### Retail & Consumer Goods

**Primary challenge**: Unifying customer identity across online, in-store, loyalty, and marketing touchpoints.

**Architecture**:
- **Data Sources**: Salesforce Commerce Cloud (orders, carts), Marketing Cloud (email engagement), POS systems (in-store transactions), Loyalty platform, Mobile app events.
- **Identity Resolution**: Email (exact) → Loyalty ID (exact) → Phone (normalized) → Name+Address (fuzzy). Source priority: CRM > Loyalty > Commerce > Marketing.
- **Key CIs**: Customer Lifetime Value (LTV), Purchase Frequency, Average Order Value, Days Since Last Purchase, Product Affinity Score.
- **Segments**: High-value at-risk (LTV > $500 + no purchase in 60 days), Cross-sell candidates (bought Category A, never bought Category B), Loyalty tier candidates.
- **Activations**: Marketing Cloud (journeys), Google/Meta Ads (lookalike audiences), Commerce Cloud (personalized recommendations).
- **Data Spaces**: By brand (if multi-brand) or by region.

### Financial Services

**Primary challenge**: Regulatory compliance (KYC, AML) while still delivering personalized experiences.

**Architecture**:
- **Data Sources**: Core banking (accounts, transactions), CRM (relationship data), Digital banking (app usage), Credit bureau data, Market data feeds.
- **Identity Resolution**: Account Number (exact) → SSN/TIN (exact, encrypted) → Email (exact) → Name+DOB (normalized). Conservative thresholds — false positives have regulatory consequences.
- **Key CIs**: Total Relationship Value, Product Penetration Score, Churn Propensity, Digital Engagement Index, Wallet Share Estimate.
- **Segments**: Pre-qualified for credit products, Wealth management candidates, At-risk relationships, Digital adoption targets.
- **Data Spaces**: Retail Banking vs. Wealth Management vs. Insurance (regulatory firewalls).
- **Special considerations**: GDPR/CCPA compliance via consent management, Data retention policies enforced per data space, Audit trail for all data access.

### Healthcare & Life Sciences

**Primary challenge**: HIPAA compliance, patient identity across disjointed provider systems.

**Architecture**:
- **Data Sources**: EHR/EMR systems, Claims data, Patient portal, Wearable/IoT health devices, Pharmacy data.
- **Identity Resolution**: MRN (exact) → Insurance ID (exact) → Name+DOB+Gender (normalized). Extra caution with fuzzy matching due to PHI sensitivity.
- **Key CIs**: Care Gap Score, Medication Adherence Rate, Risk Stratification Score, Cost of Care, Patient Satisfaction Composite.
- **Segments**: Patients due for preventive care, High-risk chronic condition cohorts, Care plan non-adherent, Post-discharge follow-up needed.
- **Data Spaces**: By provider network, by care setting (inpatient vs. outpatient), by research vs. operations.

### Media, Entertainment & Telecom

**Primary challenge**: Massive event volumes (content consumption, network events) requiring real-time personalization.

**Architecture**:
- **Data Sources**: Content management system, Streaming/viewing events, Subscription management, Ad serving platforms, Social media, Network usage (telco).
- **Identity Resolution**: Subscriber ID (exact) → Email (exact) → Device ID (normalized) → Household inference (fuzzy).
- **Key CIs**: Content Affinity Scores (by genre, by time-of-day), Engagement Depth, Churn Propensity, ARPU, Ad Response Rate.
- **Segments**: Binge watchers (engagement-based), Cord-cut risk, Upsell to premium tier, Content recommendation cohorts.
- **Special considerations**: Streaming Segments for real-time content recommendations, Zero-copy federation to Snowflake/Databricks for large-scale content analytics, High-volume Ingestion API for clickstream data.

### Manufacturing & B2B

**Primary challenge**: Account-level (not individual-level) unification across sales, service, and IoT.

**Architecture**:
- **Data Sources**: ERP (orders, inventory), CRM (opportunities, cases), IoT platforms (machine telemetry), Partner portals, Distributor data.
- **Identity Resolution**: Primarily account-level (`UnifiedAccount__dlm`). DUNS number (exact) → Company Name+Address (normalized) → Domain (exact).
- **Key CIs**: Account Health Score, Product Usage Intensity, Service Ticket Velocity, Contract Renewal Probability, Cross-sell Readiness.
- **Segments**: Accounts approaching contract renewal, High service-ticket accounts, Expansion-ready accounts, At-risk accounts.
- **Data Spaces**: By business unit, by product line, by region.

---

## 5. DataKits — Packaging & Deployment

DataKits are the packaging and deployment mechanism for Data Cloud configurations. They bundle metadata components into deployable units that can be moved between orgs (dev → staging → production) or distributed to customers/partners.

### DataKit Types

#### Standard DataKits (Change Sets)

- **Deployment method**: Salesforce UI (Change Sets) or Metadata API.
- **Audience**: Admins managing org-to-org promotions.
- **How it works**: Select components in the source org, create a Change Set, upload to target org, deploy.
- **Best for**: Organizations using Salesforce's native deployment pipeline, teams without CLI expertise, smaller implementations with fewer components.

#### DevOps DataKits (CLI / Git)

- **Deployment method**: Salesforce CLI (`sf` commands), Git-based source tracking, CI/CD pipelines.
- **Audience**: Developers and DevOps teams.
- **How it works**: Retrieve metadata to local files, commit to Git, deploy via CLI or CI/CD.
- **Best for**: Large implementations, teams practicing DevOps, automated deployment pipelines, multi-developer collaboration.

### Packagable Components

DataKits can include the following Data Cloud component types:

| Component | API Type | Notes |
|-----------|----------|-------|
| Data Model Objects (DMOs) | `CustomObject` (with `__dlm` suffix) | Schema definitions only, not data |
| Field Mappings | `DataStreamMapping` | Source-to-DMO field alignment |
| Calculated Insights | `CalculatedInsight` | CI SQL definition + schedule |
| Segments | `Segment` | Segment definition + publish schedule |
| Identity Resolution Rules | `IdentityResolutionRuleset` | Match + reconciliation rules |
| Data Transforms | `DataTransform` | Transform SQL + schedule |
| Semantic Data Models | `SemanticModel` | Full model with objects, dims, measures |
| Activations | `Activation` | Target + mapping configuration |
| Data Actions | `DataAction` | Action definitions + targets |
| Data Streams | `DataStream` | Connector + ingestion configuration |
| Connections | `Connection` | Connector credentials (handled carefully) |

### Manifest Structure

DataKits use a `package.xml` manifest:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>MyCustomDMO__dlm</members>
    <name>CustomObject</name>
  </types>
  <types>
    <members>MyCalculatedInsight</members>
    <name>CalculatedInsight</name>
  </types>
  <types>
    <members>MySegment</members>
    <name>Segment</name>
  </types>
  <version>62.0</version>
</Package>
```

### REST API Deployment Flow

For programmatic deployment (which the MCP server supports):

1. **List DataKits** — `d360_datakit_list` to see existing packages.
2. **Get DataKit** — `d360_datakit_get` to inspect contents.
3. **View Manifest** — `d360_datakit_manifest` to see the package.xml.
4. **Check Component Status** — `d360_datakit_component_status` for each component's deployment state.
5. **Check Dependencies** — `d360_datakit_component_deps` to understand what depends on what.
6. **Deploy** — `d360_datakit_deploy` to push to the target.
7. **Monitor** — `d360_datakit_deploy_status` to track deployment progress.
8. **Undeploy** — `d360_datakit_undeploy` if rollback is needed.

### Dependency Ordering (Critical)

**This is the #1 gotcha with DataKits.** Components must be deployed in dependency order. If Component B references Component A, Component A must be deployed first.

The correct deployment order is:

1. **Connections** (external system credentials)
2. **DMOs** (schema definitions)
3. **Data Streams** (depend on connections + DMOs)
4. **Field Mappings** (depend on data streams + DMOs)
5. **Identity Resolution Rules** (depend on DMOs)
6. **Calculated Insights** (depend on DMOs + IR)
7. **Semantic Data Models** (depend on DMOs)
8. **Segments** (depend on DMOs + CIs + IR)
9. **Activation Targets** (external target configuration)
10. **Activations** (depend on segments + targets)
11. **Data Actions** (depend on DMOs + activations)
12. **Data Transforms** (depend on DMOs, can be at various levels)

Deploying out of order will result in cryptic validation errors.

### DataKit Gotchas & Limitations

1. **Cross-dataspace constraints** — A DataKit deployed in one data space cannot reference components in another data space. Plan your data space boundaries before packaging.

2. **Credential handling** — Connection credentials (passwords, API keys) are NOT included in DataKit exports for security. You must re-enter credentials in the target org after deployment.

3. **Environment-specific values** — Instance URLs, API endpoints, and org-specific IDs are embedded in component metadata. Use post-deployment scripts to update these.

4. **IR rule ordering matters** — Identity Resolution rules are evaluated in sequence. The order in the DataKit must match the intended evaluation order.

5. **Segment SQL may break** — If a segment references a CI or DMO that doesn't exist in the target org, deployment will succeed but the segment will fail at publish time. Always deploy dependencies first.

6. **No partial rollback** — If a multi-component deploy partially fails, you may end up in an inconsistent state. Deploy incrementally (group by dependency tier) rather than all at once.

7. **Version pinning** — DataKits are tied to an API version. Moving from v60.0 to v62.0 may require metadata format changes.

8. **Naming collisions** — If the target org already has a component with the same API name, the deploy will overwrite it. Use unique prefixes or namespaces.

9. **Activation targets need re-authentication** — Even if the target definition deploys, OAuth connections to external ad platforms or marketing tools need to be re-authorized in the target org.

10. **Data is never included** — DataKits package only metadata (schema, configuration, rules). Actual customer data never moves. You need to re-run ingestion, IR, and CIs in the target org.

11. **Deploy status is asynchronous** — Large deployments can take minutes. Always poll `d360_datakit_deploy_status` rather than assuming immediate completion.

12. **Standard DMOs can't be packaged** — Only custom DMOs are included. Standard DMOs (Individual__dlm, etc.) are assumed to exist in the target org.

13. **Testing limitations** — There's no "dry run" mode. The closest equivalent is using `d360_datakit_component_deps` to validate dependencies before deploying.

### Pre-Built Starter Bundles

Salesforce offers industry-specific DataKit bundles that provide pre-configured Data Cloud setups:

- **Retail**: Standard DMOs for orders, products, loyalty + pre-built CIs for LTV, RFM scoring + common segments.
- **Financial Services**: Account/household models + compliance-oriented IR rules + relationship scoring CIs.
- **Healthcare**: Patient/provider models + care gap CIs + HIPAA-compliant data space templates.
- **Manufacturing**: Asset/telemetry models + IoT-oriented data streams + predictive maintenance CIs.

These are starting points, not complete solutions. Expect to customize 40–60% of the configuration for your specific implementation.

---

## 6. Integration Patterns

### Batch Ingestion

The standard pattern for most data sources. Data is pulled on a schedule (hourly, daily) via connectors.

- **Salesforce CRM Connector**: Zero-config for standard Salesforce objects. Syncs automatically.
- **MuleSoft Connector**: For complex integrations requiring transformation before ingestion.
- **S3/GCS Connector**: Drop files in a bucket, Data Cloud picks them up on schedule.
- **Custom Connector**: Build your own using the Connector Framework.

### Streaming Ingestion

For real-time use cases, use the Ingestion API:

```
POST /services/data/v{version}/ssot/event/publish
{
  "sourceObjectName": "MyEventStream__dlm",
  "data": [
    { "field1": "value1", "field2": "value2", "timestamp": "2026-03-28T10:00:00Z" }
  ]
}
```

Best practices:
- Use batch publish for throughput (up to 1000 records per call).
- Include a timestamp field for event ordering.
- Implement retry logic with exponential backoff.
- Monitor ingestion lag via the Data Stream status endpoints.

### Zero-Copy Federation

Query external data warehouses without moving data:

- **Snowflake**: Native connector, shares data via Snowflake Secure Data Sharing.
- **BigQuery**: Uses BigQuery Storage API for direct reads.
- **Databricks**: Delta Sharing protocol.
- **Redshift**: Federated query via JDBC.

Zero-copy data appears as DMOs in Data Cloud and can be used in segments, CIs, and SDMs. However:
- Query latency is higher than native Data Cloud data.
- Some operations (IR, certain CI patterns) require data to be ingested, not federated.
- Cost is incurred on the external platform for query compute.

### Outbound — Activations & Data Actions

- **Marketing Cloud**: Native activation for journey entry, audience sync.
- **Ad Platforms**: Google Ads Customer Match, Meta Custom Audiences, TikTok Audiences.
- **Cloud Storage**: S3, GCS, Azure Blob for data warehouse loads.
- **Webhooks**: Custom HTTP endpoints for real-time triggers.
- **Data Actions**: Event-driven, triggered by data changes rather than segment membership.

---

## 7. Implementation Playbook

### Phased Rollout (Recommended)

#### Phase 1: Foundation (Weeks 1–4)

- Define Data Spaces (if multi-brand/region).
- Create or customize DMOs for your domain.
- Configure Connectors and Data Streams for 2–3 primary data sources.
- Set up field mappings.
- Configure basic Identity Resolution (exact match rules only).
- Validate data quality with queries.

#### Phase 2: Intelligence (Weeks 5–8)

- Build Calculated Insights for key business metrics.
- Create Semantic Data Models for business user analytics.
- Add normalized match rules to IR.
- Build initial segments (start with 5–10 core audiences).
- Validate unified profiles against known test records.

#### Phase 3: Activation (Weeks 9–12)

- Configure Activation Targets.
- Set up Activations for key segments.
- Implement Data Actions for event-driven use cases.
- Build Data Transforms for complex data preparation.
- Add fuzzy match rules to IR (carefully, with QA).

#### Phase 4: Optimization (Ongoing)

- Monitor and tune IR match quality.
- Optimize CI performance and scheduling.
- Add streaming segments and rapid segments where needed.
- Expand to additional data sources.
- Package stable configurations into DataKits for environment promotion.
- Implement GDPR/privacy workflows.

### Sizing & Performance Considerations

- **Identity Resolution**: Processing time scales with record count squared (matching is O(n²) in the worst case). Start with exact-match-only rules and add fuzzy matching incrementally.
- **Calculated Insights**: Complex CIs with multiple JOINs can be slow. Keep CI SQL as simple as possible; use Data Transforms for pre-processing.
- **Segments**: Each additional filter condition in a segment adds query complexity. Use CIs to pre-compute complex conditions, then segment on CI outputs.
- **Query Performance**: Use `rowLimit` on all queries. The default can return massive result sets.
- **API Rate Limits**: Data Cloud shares Salesforce's API rate limits. Batch operations where possible.

---

## 8. Anti-Patterns & Gotchas

### Data Modeling Anti-Patterns

1. **Over-normalizing DMOs** — Don't create a DMO for every table in your source system. Consolidate into the standard model where possible.
2. **Ignoring the standard model** — Don't create custom DMOs when standard ones fit. Standard DMOs have pre-built IR support and segmentation shortcuts.
3. **Missing primary keys** — Every DMO needs a reliable primary key. Without one, incremental ingestion won't work correctly.
4. **Circular relationships** — DMO relationships must be acyclic. Circular references break segmentation and Data Graph queries.

### Identity Resolution Anti-Patterns

5. **Starting with fuzzy matching** — Always start with exact match rules. Add fuzzy matching only after validating exact match quality.
6. **Using too-broad match keys** — Matching on first name + city alone will create massive false-positive clusters.
7. **Not setting confidence thresholds** — Default fuzzy thresholds are too aggressive for most use cases.
8. **Ignoring reconciliation rules** — If you don't specify reconciliation, the system picks field values semi-randomly. Always define explicit rules for important fields.

### Segmentation Anti-Patterns

9. **Overly complex segment SQL** — If your segment definition is > 20 lines of SQL, it's too complex. Pre-compute conditions in CIs.
10. **Relying on real-time for batch use cases** — Don't use Streaming Segments for weekly campaign audiences. Standard segments are cheaper and sufficient.
11. **Not testing with publish** — Segment definitions can validate successfully but produce zero results due to data issues. Always test with an actual publish.

### Integration Anti-Patterns

12. **Full refresh for large tables** — Use incremental ingestion. Full refresh on tables with millions of rows wastes compute and creates unnecessary processing load.
13. **Not handling API errors** — Data Cloud APIs can return transient errors (429 rate limits, 503 service unavailable). Implement retry with exponential backoff.
14. **Ignoring data latency** — Don't assume data is available immediately after ingestion. There's a processing pipeline (ingestion → mapping → IR → CI refresh → segment refresh) that takes time.

### DataKit Anti-Patterns

15. **Big-bang deployments** — Don't deploy all components at once. Deploy in dependency order, tier by tier.
16. **Not testing in a sandbox first** — Always deploy to a sandbox or scratch org before production.
17. **Hardcoded org-specific values** — Use parameterized configurations where possible to make DataKits portable.

---

---

## 9. MCP Server — Smart Tools & Enhancements

The CDP MCP server includes intelligent tools beyond basic CRUD operations:

### Smart Mapping (`d360_smart_mapping`)
Auto-generates DLO-to-DMO field mappings by comparing field names, labels, and data types. Returns a ready-to-use mapping payload with confidence scores and unmatched field reports.

### Smart Data Stream (`d360_smart_datastream`)
For Engagement category streams, auto-selects the best immutable event date column. Ranks all date/datetime fields by suitability and excludes mutable fields like `LastModifiedDate`.

### Tool Catalog (`d360_discover`)
A searchable registry of all 108+ tools with descriptions, HTTP methods, API paths, body schemas, and usage examples. LLMs use this to find the right tool for a task.

### Execution Planning (`d360_plan_execution`)
For multi-component workflows (CIs → Segments → SDMs), computes a topologically-sorted execution plan with parallel phases. Ensures dependencies are satisfied before proceeding.

### Wait-Ready Helpers
`d360_ci_wait_ready` and `d360_segment_wait_ready` poll until components reach ACTIVE status, enabling orchestration of dependent component creation.

### connectorType Enforcement
All connection tools require `connectorType` as a parameter, enforced at the schema level. This prevents the common `ILLEGAL_QUERY_PARAMETER_VALUE` error when calling the `/ssot/connections` API.

---

*This guide was compiled from research on Salesforce Data Cloud documentation, developer resources, Trailhead modules, community best practices, and API specification analysis. Last updated: March 2026.*
