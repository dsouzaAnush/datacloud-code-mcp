#!/usr/bin/env node
import { execSync } from "node:child_process";
import { randomBytes, createCipheriv } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

function parseScopes(scope) {
  if (!scope || typeof scope !== "string") {
    return [];
  }
  return scope
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveDirectDataCloudFromEnv() {
  const accessToken = process.env.DATACLOUD_ACCESS_TOKEN;
  const instanceUrl = process.env.DATACLOUD_INSTANCE_URL;

  if (accessToken && instanceUrl) {
    return {
      accessToken,
      instanceUrl,
      scope: parseScopes(process.env.DATACLOUD_SCOPE),
      source: "environment:datacloud"
    };
  }

  return null;
}

function resolveSalesforceFromSfCli() {
  const targetOrg = process.env.SF_TARGET_ORG || process.env.TARGET_ORG;
  const baseCmd = targetOrg
    ? `sf org display --target-org ${JSON.stringify(targetOrg)} --verbose --json`
    : "sf org display --verbose --json";

  try {
    const raw = execSync(baseCmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parsed = JSON.parse(raw);
    const result = parsed.result || {};
    if (typeof result.accessToken === "string" && typeof result.instanceUrl === "string") {
      return {
        accessToken: result.accessToken,
        instanceUrl: result.instanceUrl,
        source: `sf org display${targetOrg ? ` (${targetOrg})` : ""}`
      };
    }
  } catch {
    // fallback to env vars
  }

  return null;
}

function resolveSalesforceFromEnv() {
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || process.env.INSTANCE_URL;

  if (accessToken && instanceUrl) {
    return {
      accessToken,
      instanceUrl,
      source: "environment:salesforce"
    };
  }

  return null;
}

async function exchangeForDataCloudToken(salesforceToken) {
  const exchangePath = process.env.DATACLOUD_TOKEN_EXCHANGE_PATH || "/services/a360/token";
  const exchangeUrl = new URL(exchangePath, salesforceToken.instanceUrl).toString();

  const payload = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: salesforceToken.accessToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token"
  });

  const response = await fetch(exchangeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Bearer ${salesforceToken.accessToken}`
    },
    body: payload.toString()
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Data Cloud token exchange failed: ${response.status} ${message}`);
  }

  const parsed = await response.json();
  if (!parsed?.access_token) {
    throw new Error("Data Cloud token exchange succeeded but access_token was missing");
  }

  return {
    accessToken: parsed.access_token,
    instanceUrl: parsed.instance_url || salesforceToken.instanceUrl,
    scope: parseScopes(parsed.scope),
    source: `${salesforceToken.source} -> token-exchange`
  };
}

const directDataCloud = resolveDirectDataCloudFromEnv();
const salesforceToken = resolveSalesforceFromSfCli() ?? resolveSalesforceFromEnv();

let resolved;
if (directDataCloud) {
  resolved = {
    ...directDataCloud,
    salesforceInstanceUrl: salesforceToken?.instanceUrl
  };
} else if (salesforceToken) {
  const exchanged = await exchangeForDataCloudToken(salesforceToken);
  resolved = {
    ...exchanged,
    salesforceInstanceUrl: salesforceToken.instanceUrl
  };
} else {
  console.error(
    "Unable to resolve token. Set DATACLOUD_ACCESS_TOKEN + DATACLOUD_INSTANCE_URL, or authenticate with `sf org login` / set SALESFORCE_ACCESS_TOKEN + SALESFORCE_INSTANCE_URL."
  );
  process.exit(1);
}

const outPath = process.env.TOKEN_STORE_PATH || "./data/tokens.integration.json";
const userId = process.env.USER_ID || "default";
const keyBase64 = process.env.TOKEN_ENCRYPTION_KEY_BASE64 || randomBytes(32).toString("base64");

const key = Buffer.from(keyBase64, "base64");
if (key.length !== 32) {
  console.error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  process.exit(1);
}

const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const payload = JSON.stringify({
  accessToken: resolved.accessToken,
  tokenType: "Bearer",
  scope: resolved.scope,
  obtainedAt: new Date().toISOString(),
  instanceUrl: resolved.instanceUrl,
  salesforceInstanceUrl: resolved.salesforceInstanceUrl
});
const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();

const store = {
  [userId]: {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  }
};

mkdirSync("./data", { recursive: true });
writeFileSync(outPath, JSON.stringify(store, null, 2), "utf8");

console.log(
  JSON.stringify(
    {
      seeded: true,
      source: resolved.source,
      user_id: userId,
      datacloud_instance_url: resolved.instanceUrl,
      salesforce_instance_url: resolved.salesforceInstanceUrl,
      token_store_path: outPath,
      token_encryption_key_base64: keyBase64
    },
    null,
    2
  )
);
