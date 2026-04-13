/**
 * convert-un-list.js
 * 
 * Converts the UN Consolidated List XML file to the JSON format
 * used by the KYC screening function.
 * 
 * Usage:
 *   node scripts/convert-un-list.js path/to/consolidated.xml
 * 
 * Download the XML from:
 *   https://www.un.org/securitycouncil/content/un-sc-consolidated-list
 */

const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const inputFile = process.argv[2];

if (!inputFile) {
  console.error("Usage: node convert-un-list.js <path-to-xml-file>");
  process.exit(1);
}

const xml = fs.readFileSync(inputFile, "utf-8");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    ["INDIVIDUAL", "ENTITY", "ALIAS", "INDIVIDUAL_ALIAS", "ENTITY_ALIAS"].includes(name),
});

const parsed = parser.parse(xml);

const results = [];

// Process INDIVIDUALS
const individuals =
  parsed?.CONSOLIDATED_LIST?.INDIVIDUALS?.INDIVIDUAL || [];

for (const individual of individuals) {
  const firstName = individual.FIRST_NAME || "";
  const secondName = individual.SECOND_NAME || "";
  const thirdName = individual.THIRD_NAME || "";
  const fourthName = individual.FOURTH_NAME || "";

  const primaryName = [firstName, secondName, thirdName, fourthName]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!primaryName) continue;

  const aliases = [];

  // Collect aliases
  const aliasArray = individual.INDIVIDUAL_ALIAS || [];
  for (const alias of aliasArray) {
    const aliasName = [
      alias.ALIAS_NAME || "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (aliasName && aliasName !== primaryName) {
      aliases.push(aliasName);
    }
  }

  const nationality =
    individual.NATIONALITY?.VALUE ||
    individual.CITIZENSHIP?.VALUE ||
    "";

  const dob =
    individual.INDIVIDUAL_DATE_OF_BIRTH?.DATE ||
    individual.INDIVIDUAL_DATE_OF_BIRTH?.YEAR ||
    "";

  results.push({
    name: primaryName,
    aliases: aliases.length > 0 ? aliases : undefined,
    un_ref: individual["@_REFERENCE_NUMBER"] || "",
    type: "individual",
    nationality: nationality || undefined,
    dob: dob || undefined,
    listed_on: individual.LISTED_ON || undefined,
  });
}

// Process ENTITIES
const entities =
  parsed?.CONSOLIDATED_LIST?.ENTITIES?.ENTITY || [];

for (const entity of entities) {
  const primaryName = entity.FIRST_NAME || entity.NAME || "";
  if (!primaryName) continue;

  const aliases = [];
  const aliasArray = entity.ENTITY_ALIAS || [];
  for (const alias of aliasArray) {
    const aliasName = alias.ALIAS_NAME || "";
    if (aliasName && aliasName !== primaryName) {
      aliases.push(aliasName);
    }
  }

  results.push({
    name: primaryName,
    aliases: aliases.length > 0 ? aliases : undefined,
    un_ref: entity["@_REFERENCE_NUMBER"] || "",
    type: "entity",
    listed_on: entity.LISTED_ON || undefined,
  });
}

const outputPath = path.join(__dirname, "../data/un-list.json");
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

console.log(`✅ Converted ${results.length} entries to ${outputPath}`);
console.log(`   Individuals: ${individuals.length}`);
console.log(`   Entities: ${entities.length}`);
