# treesession Routing Score Formulation (MVP)

## 1) Branch score
For each candidate branch $b$, compute raw score:

$$
S_{raw}(b)=0.62\cdot J(K_q, K_b)+0.23\cdot A(b)+0.15\cdot T(q,b)+C(b)
$$

Then clamp to stable range:

$$
S(b)=\operatorname{clip}(S_{raw}(b), 0, 1)
$$

Where:
- $J(K_q, K_b)$: Jaccard overlap between prompt keywords and branch keywords.
- $A(b)$: **relative activity score** (session-relative, no fixed hour decay).
- $T(q,b)$: title hint score between prompt and branch title.
- $C(b)$: continuity bonus = 0.08 if $b$ is active branch, else 0.

## 2) Relative activity score

$$
A(b)=0.7\cdot R_{rel}(b)+0.3\cdot U_{rel}(b)
$$

### Relative recency (within current session branches)
Let age be $\Delta t_b = now - lastActiveAt_b$.

$$
R_{rel}(b)=1-\frac{\Delta t_b-\min_j\Delta t_j}{\max_j\Delta t_j-\min_j\Delta t_j}
$$

with guard: if all ages equal, set $R_{rel}=0.5$.

### Relative usage
$$
U_{rel}(b)=\frac{turnCount_b}{\max_j turnCount_j}
$$

with guard: if all turnCount are zero, set $U_{rel}=0$.

This makes routing adapt to each user/session activity pattern (instead of hard-coding 6h/12h assumptions).

## 3) Routing decision
1. If user gives forced command (`topic: X`):
   - exact normalized title match -> forced existing branch
   - else forced new branch.
2. If no branch exists -> create new branch.
3. If prompt is very short (`len < shortTurnMinChars`) and active branch exists -> keep active branch.
4. Else compute $S(b)$ for all branches.
5. If top score `< createThreshold` -> create new branch.
6. If top two scores differ by `< ambiguityMargin` and top is not active branch -> keep active branch (anti-thrashing).
7. Otherwise choose top-scoring branch.

## 4) Default parameters
- `createThreshold = 0.22`
- `ambiguityMargin = 0.06`
- `shortTurnMinChars = 8`
- Weights: semantic 0.62, activity 0.23, title 0.15, continuity +0.08
- Activity blend: recency 0.7, usage 0.3

## 5) How to test score behavior
Run:

```bash
node scripts/test-router-score.mjs
```

It prints:
- selected action/branch
- per-branch score breakdown (`semantic`, `activity`, `title`, `continuity`, `total`).

## 6) Expected sanity checks
- Implementation-like prompt should prefer implementation branch.
- Very short acknowledgements should stay on active branch.
- `topic: <name>` must override automatic routing.
- Ambiguous top-2 scores should keep active branch.
