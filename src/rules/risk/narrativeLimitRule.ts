import { CONFIG } from '../../config';
import { RuleContext, RuleResult, TradingRule } from '../types';

export function parseTokenNarrative(symbol: string = '', name: string = ''): string {
  const text = `${symbol} ${name}`.toLowerCase();
  if (/dog|shib|inu|bonk|floki|wif|pup|canine|hound/.test(text)) return 'DOG';
  if (/cat|meow|kitty|neko|mimi|feline|happycat/.test(text)) return 'CAT';
  if (/ai|gpt|agent|bot|intelligence|compute|neural|agi|virtual/.test(text)) return 'AI';
  if (/trump|biden|kamala|maga|vote|politic|usa|presid/.test(text)) return 'POLITICS';
  if (/pepe|frog|toad|kek|ribbit/.test(text)) return 'PEPE';
  return 'OTHER';
}

export class NarrativeLimitRule implements TradingRule {
  id = 'RISK_NARRATIVE_LIMIT';
  name = 'Narrative Sector Concentration Shield';
  description = 'Prevents correlated portfolio risk by limiting open positions within the same sector (e.g. max 2 AI or MEME coins).';
  category = 'RISK' as const;
  isHardGate = true;
  weight = 8;

  evaluate(context: RuleContext): RuleResult {
    const { marketData, openPositions } = context;

    if (!marketData) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 75,
        weight: this.weight,
        reason: 'Data pasar tidak lengkap untuk identifikasi sektor narasi'
      };
    }

    const currentNarrative = parseTokenNarrative(marketData.symbol, marketData.name);
    if (currentNarrative === 'OTHER') {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: false,
        passed: true,
        action: 'ALLOW',
        score: 85,
        weight: this.weight,
        reason: 'Sektor token terdiversifikasi (kategori OTHER)',
        metricDetails: { narrative: currentNarrative }
      };
    }

    const matchingPositions = openPositions.filter(p => 
      parseTokenNarrative(p.token_symbol, p.token_name) === currentNarrative
    );

    const maxAllowed = CONFIG.MAX_POSITIONS_PER_NARRATIVE || 2;

    if (matchingPositions.length >= maxAllowed) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        category: this.category,
        isHardGate: this.isHardGate,
        passed: false,
        action: 'REJECT',
        score: 10,
        weight: this.weight,
        reason: `Konsentrasi Sektor Tercapai! Portofolio sudah memiliki ${matchingPositions.length} koin di sektor ${currentNarrative} (${matchingPositions.map(p => p.token_symbol).join(', ')}). Mencegah risiko dump terkorelasi.`,
        metricDetails: {
          currentNarrative,
          matchingPositionsCount: matchingPositions.length,
          maxAllowed
        }
      };
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      category: this.category,
      isHardGate: this.isHardGate,
      passed: true,
      action: 'ALLOW',
      score: 90,
      weight: this.weight,
      reason: `Sektor narasi ${currentNarrative} masih memiliki kuota (${matchingPositions.length}/${maxAllowed} aktif)`,
      metricDetails: {
        currentNarrative,
        matchingPositionsCount: matchingPositions.length,
        maxAllowed
      }
    };
  }
}
