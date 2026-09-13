# Примеры Feedback Loop (BRONVERA Курпатов v2.0)

**Версия:** 1.0  
**Дата:** 2026-09-13  
**Файл:** Демонстрация работы пересчётов при противоречиях

---

## 📋 СЦЕНАРИЙ 1: GOOD_STATE_LOW_PRICE

### 🚗 Машина
```json
{
  "lotNumber": "12345678",
  "make": "BMW",
  "model": "X5",
  "year": 2015,
  "currentBid": 800000,
  "location": "Московская область"
}
```

### ЭТАП 1: Первичный анализ

#### Assessor (первый анализ):
```json
{
  "condition_overall": "light",
  "visible_damage": "Минимальные вмятины кузова",
  "hidden_defects": [],
  "repair_estimate_min": 50000,
  "repair_estimate_max": 150000,
  "confidence": 82,
  "ready_for_reassessment": true
}
```

#### Market Analyst:
```json
{
  "average_market_price": 1200000,
  "fair_price": 780000,
  "confidence": 88,
  "anomalies_detected": [
    {
      "anomaly": "Машина на 35% дешевле среднего рынка",
      "interpretation": "Либо срочная продажа, либо скрытые дефекты",
      "recommendation": "Требует уточнения у Assessor"
    }
  ]
}
```

### 🔍 ВЕРИФИКАЦИЯ (Orchestrator)

```
✅ Проверка VerificationRules.checkConsistency():

ПРОТИВОРЕЧИЕ НАЙДЕНО!
- Type: GOOD_STATE_LOW_PRICE
- Severity: warning
- Description: Хорошее состояние (light) но цена на 35% ниже рынка
- Interpretation: Возможны: 1) Срочная продажа, 2) Скрытые дефекты, 3) Ошибка в оценке
- Action: REQUEST_REASSESSMENT
- Target: assessor
```

### 🔄 REASSESSMENT (Пересчёт)

**Вопрос Assessor:**
```
Перепроверь состояние лота. Обнаружено противоречие: 
Хорошее состояние (light) но цена на 35% ниже рынка.

Ищи скрытые дефекты, которые могут объяснить это противоречие:
- Проверь электросистему
- Проверь подвеску
- Проверь двигатель на утечки
- Спрос на дополнительную диагностику

Fair price: 780000 RUB
Average price: 1200000 RUB
```

**Assessor (пересчёт):**
```json
{
  "condition_overall": "moderate",
  "visible_damage": "Минимальные вмятины кузова",
  "hidden_defects": [
    "Возможные проблемы с подвеской (асимметрия заметна)",
    "Электропровода могут быть повреждены (видны потёки влаги)"
  ],
  "repair_estimate_min": 300000,
  "repair_estimate_max": 600000,
  "confidence": 78,
  "anomalies_detected": [
    {
      "anomaly": "Хорошее внешнее состояние, но скрытые дефекты",
      "interpretation": "Возможен кузовной ремонт с маскировкой проблем",
      "impact_on_price": "Скрытые дефекты могут быть серьёзнее"
    }
  ],
  "ready_for_reassessment": false
}
```

### ✅ РЕЗУЛЬТАТ (после пересчёта)

```
Итерация 1: Пересчёт assessor (GOOD_STATE_LOW_PRICE) ✅

Финальные цифры:
- Purchase Price: 800,000 RUB
- Repair Cost: 450,000 RUB (усреднённо)
- Market Value: 1,200,000 RUB
- ROI: -50,000 RUB ❌ (отрицательный!)

Рекомендация: ❌ ПРОПУСТИТЬ

Уверенность: 78% (была 82%, упала из-за скрытых дефектов)
Противоречия: Разрешены ✅
Статус: Consistent
```

---

## 📋 СЦЕНАРИЙ 2: BAD_STATE_HIGH_PRICE

### 🚗 Машина
```json
{
  "lotNumber": "87654321",
  "make": "Mercedes",
  "model": "E-Class",
  "year": 2012,
  "currentBid": 1500000,
  "location": "Санкт-Петербург"
}
```

### ЭТАП 1: Первичный анализ

#### Assessor (первый анализ):
```json
{
  "condition_overall": "severe",
  "visible_damage": "Серьёзные повреждения кузова, ржавчина, проблемы с двигателем",
  "repair_estimate_min": 800000,
  "repair_estimate_max": 1200000,
  "confidence": 85,
  "risk": "HIGH",
  "ready_for_reassessment": true
}
```

#### Market Analyst:
```json
{
  "average_market_price": 950000,
  "fair_price": 1450000,
  "confidence": 82,
  "anomalies_detected": [
    {
      "anomaly": "Машина на 53% дороже среднего рынка",
      "interpretation": "Либо редкая комплектация, либо переоценка",
      "recommendation": "Перепроверить рыночные данные"
    }
  ]
}
```

### 🔍 ВЕРИФИКАЦИЯ

```
✅ Проверка VerificationRules.checkConsistency():

ПРОТИВОРЕЧИЕ НАЙДЕНО!
- Type: BAD_STATE_HIGH_PRICE
- Severity: critical
- Description: Серьёзные повреждения (severe) но цена на 53% выше рынка
- Interpretation: Машина переоценена ИЛИ есть редкие комплектации
- Action: REQUEST_REASSESSMENT
- Target: marketAnalyst
```

### 🔄 REASSESSMENT

**Вопрос Market Analyst:**
```
Перепроверь рыночные данные для этого авто.
Обнаружено противоречие: Серьёзные повреждения (severe) но цена на 53% выше рынка.

Возможна ошибка в анализе цен или отсутствие редких комплектаций.

Состояние: severe
Смета ремонта: 800000-1200000 RUB
```

**Market Analyst (пересчёт):**
```json
{
  "average_market_price": 950000,
  "fair_price": 950000,
  "confidence": 75,
  "market_analysis": {
    "average_market_price": 950000,
    "recommended_selling_price": 950000,
    "demand_level": "low",
    "average_sale_days": 45
  },
  "market_trend": {
    "direction": "down",
    "percent_change_month": "-3%",
    "interpretation": "Рынок падает, машины дешевеют"
  },
  "anomalies_detected": [
    {
      "anomaly": "Цена выше рынка при плохом состоянии",
      "interpretation": "Ошибка продавца или попытка завышить цену",
      "recommendation": "Машина переоценена, ждите снижения цены"
    }
  ],
  "ready_for_reassessment": false
}
```

### ✅ РЕЗУЛЬТАТ

```
Итерация 1: Пересчёт marketAnalyst (BAD_STATE_HIGH_PRICE) ✅

Финальные цифры:
- Purchase Price: 1,500,000 RUB
- Repair Cost: 1,000,000 RUB (усреднённо)
- Market Value: 950,000 RUB
- ROI: -1,550,000 RUB ❌❌ (очень отрицательный!)

Рекомендация: ❌ ПРОПУСТИТЬ

Уверенность: 75% (была 82%)
Противоречия: Разрешены ✅
Статус: Consistent
```

---

## 📋 СЦЕНАРИЙ 3: HIGH_ROI_LOW_CONFIDENCE

### 🚗 Машина
```json
{
  "lotNumber": "11223344",
  "make": "Audi",
  "model": "A6",
  "year": 2016,
  "currentBid": 700000,
  "location": "Казань"
}
```

### ЭТАП 1: Первичный анализ

#### Selector:
```json
{
  "confidence": 60,
  "reason": "Выбрал машину, но только видна основная информация",
  "ready_for_reassessment": true
}
```

#### Assessor (первый анализ):
```json
{
  "condition_overall": "light",
  "repair_estimate_min": 100000,
  "repair_estimate_max": 250000,
  "confidence": 65,
  "notes": "Фото плохого качества, трудно видеть детали"
}
```

#### Market Analyst:
```json
{
  "average_market_price": 1000000,
  "fair_price": 1100000,
  "confidence": 70,
  "notes": "Малое количество данных по этому авто"
}
```

### 🔍 ВЕРИФИКАЦИЯ

```
✅ Проверка VerificationRules.checkConsistency():

АНОМАЛИЯ НАЙДЕНА!
- Type: HIGH_ROI_LOW_CONFIDENCE
- Severity: warning
- Description: Высокий ROI (350,000 RUB) при низкой уверенности (60%)
- Interpretation: Слишком рискованно для большой суммы
- Recommendation: WATCH вместо BUY

Расчёт:
ROI = Fair Price (1,100,000) - Purchase (700,000) - Repair (175,000) = 225,000 RUB
Min Confidence = 60% (Selector)
```

### 📊 РЕЗУЛЬТАТ

```
Рекомендация: ⚠️ WATCH (не BUY!)

Хотя ROI положительный (225,000 RUB), уверенность слишком низкая:
- Selector: 60% (видит только параметры)
- Assessor: 65% (фото плохого качества)
- Market: 70% (мало данных)

Действие: Добавить в наблюдение (WATCH list)
- Ждать более качественных фото
- Собрать больше рыночных данных
- Повторить анализ позже

Уверенность: 60%
Статус: Requires more information
```

---

## 📋 СЦЕНАРИЙ 4: MANY_HIDDEN_DEFECTS

### 🚗 Машина
```json
{
  "lotNumber": "55667788",
  "make": "Toyota",
  "model": "Camry",
  "year": 2010,
  "currentBid": 400000,
  "location": "Екатеринбург"
}
```

### ЭТАП 1: Первичный анализ

#### Assessor (первый анализ):
```json
{
  "condition_overall": "moderate",
  "repair_estimate_min": 200000,
  "repair_estimate_max": 450000,
  "hidden_defects": [
    "Возможные проблемы с подвеской (видна асимметрия)",
    "Электропровода могут быть повреждены",
    "Коррозия на днище кузова",
    "Возможны проблемы с двигателем (стук при запуске)"
  ],
  "confidence": 73,
  "ready_for_reassessment": true
}
```

#### Market Analyst:
```json
{
  "average_market_price": 700000,
  "fair_price": 750000,
  "confidence": 85
}
```

### 🔍 ВЕРИФИКАЦИЯ

```
✅ Проверка VerificationRules.checkConsistency():

АНОМАЛИЯ НАЙДЕНА!
- Type: MANY_HIDDEN_DEFECTS
- Severity: warning
- Description: Найдено много потенциальных скрытых дефектов (4)
- Interpretation: Реальная смета может быть выше
- Recommendation: Увеличить бюджет ремонта на 20-30%

Скрытые дефекты: 4 (> 3)
```

### 📊 РЕЗУЛЬТАТ

```
Финальные цифры:
- Purchase Price: 400,000 RUB
- Repair Cost: 325,000 RUB (усреднённо)
- Market Value: 750,000 RUB
- ROI: 25,000 RUB ✅ (небольшой)

Рекомендация: ✅ РАССМОТРЕТЬ (с осторожностью)

⚠️ ВАЖНО:
- Много скрытых дефектов (4 шт)
- Смета может быть завышена на 20-30%
- Рекомендуется увеличить бюджет на 60,000-97,500 RUB
- Настоящий ROI может быть -35,500 - +25,000 RUB

Уверенность: 73%
Статус: Requires professional inspection
```

---

## 🔄 FEEDBACK LOOP: ПОЛНЫЙ ЦИКЛ

### Пример: GOOD_STATE_LOW_PRICE → RESOLUTION

```
ИТЕРАЦИЯ 0 (Начальный анализ):
├─ Assessor: condition_overall = "light" ✅
├─ Market: fair_price 35% ниже среднего ⚠️
└─ Contradiction: GOOD_STATE_LOW_PRICE detected

ПРОТИВОРЕЧИЕ ОБНАРУЖЕНО:
└─ "Хорошее состояние но низкая цена = скрытые дефекты?"

ИТЕРАЦИЯ 1 (Reassessment):
├─ Requestor: Orchestrator
├─ Target Agent: assessor
├─ Request: "Перепроверь скрытые дефекты"
├─ Response: hidden_defects: 2 items found
├─ Assessor: condition_overall = "moderate" (изменился!)
└─ ROI: 100,000 → -50,000 (стал отрицательным)

ИТЕРАЦИЯ 2 (Verification):
├─ Check: hasContradictions = false ✅
├─ Status: CONSISTENT
└─ Recommendation: SKIP

SUMMARY:
├─ Total Iterations: 1
├─ Contradictions Found: 1
├─ Contradictions Resolved: 1 ✅
├─ Final Confidence: 78%
└─ Decision Changed: CONSIDER → SKIP
```

---

## 🎯 КЛЮЧЕВЫЕ ПАТТЕРНЫ

### ✅ Когда Feedback Loop помогает:
- Противоречия между состоянием и ценой
- Аномальные ROI при низкой уверенности
- Скрытые дефекты меняют оценку

### ❌ Когда Feedback Loop НЕ срабатывает:
- Нет противоречий (агенты согласны)
- Недостаточно данных (фото плохого качества)
- Market данные устарели

### 📊 Метрики пересчёта:
```
- Iterations per car: 0-3 (обычно 0-1)
- Confidence change: ±10-20%
- ROI change: может быть значительным
- Processing time: +500ms-2s per reassessment
```

---

## 🚀 КАК ЗАПУСТИТЬ ПРИМЕРЫ

```bash
# 1. Создать тестовый файл
cp examples/feedback-loop-scenarios.md tests/test-data.md

# 2. Запустить orchestrator с этими данными
node src/test-scenarios.js

# 3. Посмотреть логи с пересчётами
grep "🔄" output.log
```

---

**Дата создания:** 2026-09-13  
**Версия:** 1.0  
**Статус:** Production ready
