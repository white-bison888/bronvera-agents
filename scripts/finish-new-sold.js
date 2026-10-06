#!/usr/bin/env node
// Доработка новых проданных лотов одного источника: node scripts/finish-new-sold.js <bat|rm-sothebys|gooding|hemmings|collecting-cars>
// Обычно запускается сервисом после суточного захода (см. src/rare/finish-new-sold.js), но можно и руками.
const { finishNewSold } = require("../src/rare/finish-new-sold");

const key = process.argv[2];
finishNewSold(key).then(() => process.exit(0)).catch((error) => {
  console.error(`finish-new-sold ${key}:`, error.message);
  process.exit(1);
});
