/**
 * Verification Rules для методологии Курпатова
 * Проверка противоречий между выводами агентов
 *
 * Курпатов принцип 4: ВЕРИФИКАЦИЯ - каждый вывод должен быть проверен
 * Курпатов принцип 5: ЦИКЛИЧЕСКОЕ УТОЧНЕНИЕ - при противоречиях запрашиваем пересчёт
 */

class VerificationRules {
  /**
   * Проверить согласованность выводов всех трёх агентов
   */
  static checkConsistency(selectorOutput, assessorOutput, marketAnalystOutput) {
    const contradictions = [];
    const anomalies = [];

    // ПРОТИВОРЕЧИЕ 1: Хорошее состояние + Низкая цена
    if (assessorOutput.condition_overall === 'light' &&
        marketAnalystOutput.fair_price < marketAnalystOutput.average_market_price * 0.90) {
      contradictions.push({
        type: 'GOOD_STATE_LOW_PRICE',
        severity: 'warning',
        description: 'Хорошее состояние (Assessor) но цена на 10%+ ниже рынка (MarketAnalyst)',
        interpretation: 'Возможны: 1) Срочная продажа, 2) Скрытые дефекты, 3) Ошибка в оценке',
        action: 'REQUEST_REASSESSMENT',
        target_agent: 'assessor'
      });
    }

    // ПРОТИВОРЕЧИЕ 2: Плохое состояние + Высокая цена
    if (assessorOutput.condition_overall === 'severe' &&
        marketAnalystOutput.fair_price > marketAnalystOutput.average_market_price * 1.10) {
      contradictions.push({
        type: 'BAD_STATE_HIGH_PRICE',
        severity: 'critical',
        description: 'Серьёзные повреждения (Assessor) но цена на 10%+ выше рынка (MarketAnalyst)',
        interpretation: 'Машина переоценена ИЛИ есть редкие комплектации',
        action: 'REQUEST_REASSESSMENT',
        target_agent: 'marketAnalyst'
      });
    }

    // ПРОТИВОРЕЧИЕ 3: Высокий ROI + Низкая уверенность
    const roi = marketAnalystOutput.fair_price - marketAnalystOutput.purchase_price;
    const minConfidence = Math.min(
      selectorOutput.confidence || 0.65,
      assessorOutput.confidence || 0.75,
      marketAnalystOutput.confidence || 0.87
    );

    if (roi > 300000 && minConfidence < 0.70) {
      anomalies.push({
        type: 'HIGH_ROI_LOW_CONFIDENCE',
        severity: 'warning',
        description: `Высокий ROI (${roi}) при низкой уверенности (${minConfidence * 100}%)`,
        interpretation: 'Слишком рискованно для большой суммы',
        recommendation: 'WATCH вместо BUY'
      });
    }

    // АНОМАЛИЯ 1: Очень дешёвая машина
    if (marketAnalystOutput.fair_price < marketAnalystOutput.average_market_price * 0.85) {
      anomalies.push({
        type: 'VERY_CHEAP',
        severity: 'info',
        description: `Машина на ${Math.round((1 - marketAnalystOutput.fair_price / marketAnalystOutput.average_market_price) * 100)}% дешевле рынка`,
        interpretation: 'Потенциальная возможность, но нужна проверка причины низкой цены',
        recommendation: 'Переспросить Assessor про скрытые дефекты'
      });
    }

    // АНОМАЛИЯ 2: Очень дорогая машина
    if (marketAnalystOutput.fair_price > marketAnalystOutput.average_market_price * 1.15) {
      anomalies.push({
        type: 'VERY_EXPENSIVE',
        severity: 'warning',
        description: `Машина на ${Math.round((marketAnalystOutput.fair_price / marketAnalystOutput.average_market_price - 1) * 100)}% дороже рынка`,
        interpretation: 'Либо редкая комплектация, либо переоценка',
        recommendation: 'Перепроверить рыночные данные'
      });
    }

    // АНОМАЛИЯ 3: Много скрытых дефектов
    if (assessorOutput.hidden_defects && assessorOutput.hidden_defects.length > 3) {
      anomalies.push({
        type: 'MANY_HIDDEN_DEFECTS',
        severity: 'warning',
        description: `Найдено много потенциальных скрытых дефектов (${assessorOutput.hidden_defects.length})`,
        interpretation: 'Реальная смета может быть выше',
        recommendation: 'Увеличить бюджет ремонта на 20-30%'
      });
    }

    return {
      hasContradictions: contradictions.length > 0,
      contradictions,
      hasAnomalies: anomalies.length > 0,
      anomalies,
      isConsistent: contradictions.length === 0,
      overallConfidence: minConfidence,
      requiresReassessment: contradictions.length > 0
    };
  }

  /**
   * Определить, нужен ли пересчёт (reassessment)
   */
  static shouldRequestReassessment(verificationResult) {
    return verificationResult.requiresReassessment;
  }

  /**
   * Получить агента, который должен пересчитать
   */
  static getReassessmentTarget(contradiction) {
    return contradiction.target_agent;
  }

  /**
   * Построить запрос на пересчёт для агента
   */
  static buildReassessmentRequest(contradiction, currentAssessment) {
    const requests = {
      assessor: {
        type: 'reassess_condition',
        question: `Перепроверь состояние лота. Обнаружено противоречие: ${contradiction.description}. Ищи скрытые дефекты, которые могут объяснить это противоречие.`,
        context: {
          fair_price: currentAssessment.marketAnalyst?.fair_price,
          average_price: currentAssessment.marketAnalyst?.average_market_price,
          contradiction: contradiction.interpretation
        }
      },
      marketAnalyst: {
        type: 'reassess_market',
        question: `Перепроверь рыночные данные для этого авто. Обнаружено противоречие: ${contradiction.description}. Возможна ошибка в анализе цен или отсутствие редких комплектаций.`,
        context: {
          condition: currentAssessment.assessor?.condition_overall,
          repair_estimate: currentAssessment.assessor?.repair_estimate_max,
          contradiction: contradiction.interpretation
        }
      },
      selector: {
        type: 'reassess_selection',
        question: `Перепроверь выбор этого лота. Обнаружено противоречие в дальнейшем анализе.`,
        context: {
          contradiction: contradiction.interpretation
        }
      }
    };

    return requests[contradiction.target_agent] || null;
  }

  /**
   * Вычислить финальную уверенность (минимум между агентами)
   */
  static calculateFinalConfidence(selectorOutput, assessorOutput, marketAnalystOutput) {
    const confidences = [
      selectorOutput.confidence || 0.65,
      assessorOutput.confidence || 0.75,
      marketAnalystOutput.confidence || 0.87
    ];

    return Math.min(...confidences);
  }

  /**
   * Проверить, готовы ли все агенты к уточнениям
   */
  static checkReadiness(selectorOutput, assessorOutput, marketAnalystOutput) {
    return {
      selectorReady: selectorOutput.ready_for_reassessment !== false,
      assessorReady: assessorOutput.ready_for_reassessment !== false,
      marketAnalystReady: marketAnalystOutput.ready_for_reassessment !== false,
      allReady: (selectorOutput.ready_for_reassessment !== false) &&
               (assessorOutput.ready_for_reassessment !== false) &&
               (marketAnalystOutput.ready_for_reassessment !== false)
    };
  }
}

module.exports = VerificationRules;
