#!/usr/bin/env node
//@ts-check

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { WebdockService } = require("../services/webdockService");

const SCRIPT_NAME = process.env.WEBDOCK_PROVISION_SCRIPT_NAME || "Nova Dedicated Server Bootstrap";
const SCRIPT_FILENAME = "nova-dedicated-bootstrap.sh";
const SCRIPT_PATH = path.join(__dirname, "dedicated-server-bootstrap.sh");

function getScriptId(script) {
  return script?.id ?? script?.scriptId ?? script?.accountScriptId;
}

function getScriptsList(responseData) {
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (Array.isArray(responseData?.scripts)) return responseData.scripts;
  if (Array.isArray(responseData?.accountScripts)) return responseData.accountScripts;
  return [];
}

async function main() {
  const webdock = new WebdockService();
  webdock.assertConfigured();

  const content = fs.readFileSync(SCRIPT_PATH, "utf8");
  const list = await webdock.listAccountScripts();
  const scripts = getScriptsList(list.data);
  const existing = scripts.find((script) => (
    String(script?.name || "") === SCRIPT_NAME ||
    String(script?.filename || "") === SCRIPT_FILENAME
  ));

  let result;
  if (existing && getScriptId(existing)) {
    result = await webdock.updateAccountScript(getScriptId(existing), {
      name: SCRIPT_NAME,
      filename: SCRIPT_FILENAME,
      content,
    });
  } else {
    result = await webdock.createAccountScript({
      name: SCRIPT_NAME,
      filename: SCRIPT_FILENAME,
      content,
    });
  }

  const script = result.data?.data || result.data;
  const scriptId = getScriptId(script) || getScriptId(existing);
  if (!scriptId) {
    console.log(JSON.stringify(result.data, null, 2));
    throw new Error("Webdock did not return a script id.");
  }

  console.log(`WEBDOCK_PROVISION_SCRIPT_ID=${scriptId}`);
  console.log("Add that value to server/.env and production .env.");
}

main().catch((error) => {
  console.error(error?.response?.data || error);
  process.exit(1);
});
