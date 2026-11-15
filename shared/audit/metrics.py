"""複核結果的指標：比例與 Wilson 信賴區間、Cohen's κ、做法與人工判定的比較。純計算，不讀寫檔案。"""

from collections import Counter
from collections.abc import Iterable
from math import comb, sqrt

Z95 = 1.96
# 技能對應的三種判定，與相近配對的四種判定（字面就是複核表下拉選單的選項）
LINK_CORRECT, LINK_GRANULARITY, LINK_WRONG = "正確", "粒度不符", "錯誤"
LINK_CHOICES = (LINK_CORRECT, LINK_GRANULARITY, LINK_WRONG)
PAIR_CHOICES = ("相同", "上下位", "相關但不同", "無關")
PAIR_ACCEPTED = frozenset({"相同", "上下位"})


def wilson(successes: int, total: int, z: float = Z95) -> tuple[float, float] | None:
    """比例的 Wilson 信賴區間；樣本數為 0 時回傳 None。小樣本或比例接近 0、1 時比常態近似可靠。"""
    if total <= 0:
        return None
    if not 0 <= successes <= total:
        raise ValueError("successes 必須介於 0 與 total 之間")
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return max(0.0, centre - half), min(1.0, centre + half)


def proportion(successes: int, total: int) -> dict:
    """{n, k, p, low, high}；沒有樣本時 p 與區間為 None。"""
    interval = wilson(successes, total)
    if interval is None:
        return {"n": 0, "k": 0, "p": None, "low": None, "high": None}
    return {"n": total, "k": successes, "p": round(successes / total, 4),
            "low": round(interval[0], 4), "high": round(interval[1], 4)}


def precision_bounds(successes: int, total: int, pending: int) -> tuple[float, float] | None:
    """還有 pending 筆沒有定論時，精確率可能落在的範圍（那幾筆全錯到全對）。"""
    if total + pending <= 0:
        return None
    return round(successes / (total + pending), 4), round((successes + pending) / (total + pending), 4)


def cohen_kappa(first: list[str], second: list[str]) -> float | None:
    """兩位標註者的一致性（扣除碰巧一致的部分）；無法計算時回傳 None。"""
    total = len(first)
    if total == 0 or total != len(second):
        return None
    observed = sum(1 for a, b in zip(first, second) if a == b) / total
    counts_a, counts_b = Counter(first), Counter(second)
    expected = sum(counts_a[label] * counts_b[label] for label in counts_a) / (total * total)
    if expected >= 1:
        return None  # 兩人都只用了同一種標記
    return (observed - expected) / (1 - expected)


def agreement(first: dict[str, str | None], second: dict[str, str | None]) -> dict:
    """兩位標註者都有填的項目中，判定相同的比例與 κ。"""
    both = sorted(key for key in first if first[key] and second.get(key))
    labels_a, labels_b = [first[key] for key in both], [second[key] for key in both]
    agree = sum(1 for a, b in zip(labels_a, labels_b) if a == b)
    kappa = cohen_kappa(labels_a, labels_b)
    return {"both": len(both), "agree": agree, "raw": round(agree / len(both), 4) if both else None,
            "kappa": None if kappa is None else round(kappa, 4)}


def link_precision(labels: Iterable[str]) -> dict:
    """技能對應的精確率：strict 只算「正確」，lenient 把「粒度不符」也算進來。"""
    counts = Counter(labels)
    total = sum(counts[choice] for choice in LINK_CHOICES)
    return {"strict": proportion(counts[LINK_CORRECT], total),
            "lenient": proportion(counts[LINK_CORRECT] + counts[LINK_GRANULARITY], total)}


def weighted_precision(by_source: dict[str, dict], population: dict[str, int], level: str = "strict") -> float | None:
    """依各來源的母體筆數加權的整體精確率（各來源抽樣數相同、母體大小不同，不能直接合併計算）。

    只要有一個來源還沒有判定就回傳 None：缺了一塊的「整體」會讓人誤以為涵蓋全部。
    """
    sources = [source for source in by_source if population.get(source)]
    if not sources or any(by_source[source][level]["p"] is None for source in sources):
        return None
    weight = sum(population[source] for source in sources)
    return round(sum(population[source] * by_source[source][level]["p"] for source in sources) / weight, 4)


def variant_scores(truth: dict[str, bool], predicted: dict[str, bool]) -> dict:
    """某種做法在人工判定過的配對上的精確率、召回率與 F1。

    召回率的分母是「人工認為相近」的配對，範圍只限於這批候選，不代表所有技能。
    """
    keys = [key for key in truth if key in predicted]
    true_positive = sum(1 for key in keys if truth[key] and predicted[key])
    precision = proportion(true_positive, sum(1 for key in keys if predicted[key]))
    recall = proportion(true_positive, sum(1 for key in keys if truth[key]))
    p, r = precision["p"], recall["p"]
    f1 = None if p is None or r is None or p + r == 0 else round(2 * p * r / (p + r), 4)
    return {"precision": precision, "recall": recall, "f1": f1}


def mcnemar_exact(first_only: int, second_only: int) -> float | None:
    """精確 McNemar 檢定（雙尾）的 p 值：兩種做法在同一批項目上，「只有甲對」與「只有乙對」的筆數差多少。

    兩種做法判斷相同的項目不提供資訊；沒有任何不一致的項目時回傳 None。
    """
    total = first_only + second_only
    if total == 0:
        return None
    tail = sum(comb(total, index) for index in range(min(first_only, second_only) + 1)) / 2 ** total
    return round(min(1.0, 2 * tail), 4)


def paired_comparison(truth: dict[str, bool], first: dict[str, bool], second: dict[str, bool]) -> dict:
    """兩種做法在同一批配對上各自對了幾筆是對方錯的，以及 McNemar 檢定的 p 值。"""
    keys = [key for key in truth if key in first and key in second]
    first_only = sum(1 for key in keys if first[key] == truth[key] and second[key] != truth[key])
    second_only = sum(1 for key in keys if second[key] == truth[key] and first[key] != truth[key])
    return {"n": len(keys), "first_only": first_only, "second_only": second_only,
            "p_value": mcnemar_exact(first_only, second_only)}
