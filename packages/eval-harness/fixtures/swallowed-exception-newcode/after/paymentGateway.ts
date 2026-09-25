const gateway = {
  chargeCard: (cardToken: string, amount: number): void => {
    if (amount <= 0) throw new Error("invalid amount");
  },
};

export function chargeCardSafely(cardToken: string, amount: number): boolean {
  try {
    gateway.chargeCard(cardToken, amount);
    return true;
  } catch (e) {}
  return false;
}
