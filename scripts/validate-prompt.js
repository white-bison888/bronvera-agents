const fs = require("fs");
const path = require("path");

function validatePrompt(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const errors = [];
  const warnings = [];

  if (!content.match(/^# /m)) {
    errors.push("❌ Отсутствует заголовок (# Название)");
  }

  if (!content.match(/## Версия:/m)) {
    errors.push("❌ Отсутствует версия (## Версия: X.Y)");
  }

  if (!content.match(/## Задача/m)) {
    warnings.push("⚠️  Рекомендуется добавить секцию '## Задача'");
  }

  if (!content.match(/## Выходной формат|## Формат выхода/m)) {
    warnings.push("⚠️  Рекомендуется указать '## Выходной формат'");
  }

  const jsonMatches = content.match(/```json\n([\s\S]*?)\n```/g);
  if (jsonMatches) {
    jsonMatches.forEach((match, idx) => {
      try {
        const jsonStr = match.replace(/```json\n/, "").replace(/\n```/, "");
        JSON.parse(jsonStr);
      } catch (e) {
        errors.push(`❌ JSON в примере ${idx + 1} невалидный: ${e.message}`);
      }
    });
  }

  if (content.length < 200) {
    warnings.push("⚠️  Промпт очень короткий, рекомендуется расширить");
  }

  return { errors, warnings, isValid: errors.length === 0 };
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node validate-prompt.js <path-to-prompt.md>");
    process.exit(1);
  }

  const result = validatePrompt(filePath);

  console.log(`\n📋 Validation Results: ${filePath}\n`);

  if (result.errors.length > 0) {
    console.log("ERRORS:");
    result.errors.forEach(e => console.log(e));
  }

  if (result.warnings.length > 0) {
    console.log("\nWARNINGS:");
    result.warnings.forEach(w => console.log(w));
  }

  if (result.isValid) {
    console.log("✅ Промпт валидный!");
  }

  process.exit(result.isValid ? 0 : 1);
}

module.exports = validatePrompt;
