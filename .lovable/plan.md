# Risk Analytics AI System for Retail Prop Trading Platform
## Revised Implementation Plan — "Detection, Not Domination"

---

## Core Principles (Non-Negotiable)

1. **AI Never Denies Earned Payouts** — System flags, humans decide
2. **No Retroactive Rule Changes** — Cohort rules are immutable once assigned
3. **Intake Throttling > Punitive Enforcement** — Control who enters, not who gets punished
4. **SIM-Only, No Market Exposure** — No hedging, no real order management
5. **Human-in-the-Loop for All Irreversible Actions** — No auto-locks, no auto-bans, no auto-denials

---

## Phase 1: MVP — Detection & Visibility (Weeks 1-4)

### 1.1 Authentication & Role-Based Access

**Four User Roles** (stored in separate `user_roles` table):
- **Traders**: Personal dashboard, challenge progress, trading metrics
- **Risk Officers**: Risk console, account reviews, flag management
- **Support Staff**: Limited view for disputes and inquiries
- **Administrators**: Full system access, configuration, user management

**Security**: Roles stored separately from profiles to prevent privilege escalation.

---

### 1.2 Database Schema (Supabase)

| Table | Purpose |
|-------|---------|
| `profiles` | User info, KYC status |
| `user_roles` | Role assignments (separate table) |
| `accounts` | Trading accounts, balance, status, cohort assignment |
| `cohorts` | Versioned rule sets (immutable once assigned) |
| `trades` | Trade event logs |
| `violations` | Rule breach detections with timestamps |
| `risk_scores` | Edge Score, Abuse Score, Payment Risk Score |
| `flags` | Pending human review items |
| `audit_logs` | Complete decision trail for all actions |
| `payouts` | Payout requests and approval status |

---

### 1.3 Risk Scoring Engine (Advisory Only)

**Edge Score** (Performance Indicator) — *Informs intake decisions, does NOT block*
- Win rate vs. population average
- Speed-to-milestone tracking
- Profit factor calculations
- Thresholds: <50 Normal | 50-80 Notable | ≥80 **Flags for Review**

**Abuse Score** (Compliance Index) — *Flags for human review, does NOT auto-lock*
- Multi-account detection signals (IP, device, email patterns)
- Coordinated trading pattern detection
- Promotion usage patterns
- Thresholds: 0-30 Good | 30-70 Caution | ≥70 **Auto-Flag + Human Review Required**

**Payment Risk Score** — *Informs payout review, does NOT block*
- Payment processor fraud signals
- Name/ID verification matching
- Geographic anomalies
- Thresholds: 0-40 Normal | 40-70 Extra Verification | ≥70 **Human Review Required**

**⚠️ Critical**: Scores are ADVISORY. They inform human decisions. They do NOT trigger automatic denial, lock, or block actions.

---

### 1.4 Deterministic Rule Engine

**What It Does**:
- Monitors rule compliance in real-time
- Calculates drawdown, daily P&L, position sizes
- **Detects** rule breaches instantly
- **Marks** account state (e.g., "Breached", "Under Review")
- **Logs** all detections to audit trail

**What It Does NOT Do**:
- ❌ Reject orders
- ❌ Auto-lock accounts
- ❌ Deny payouts
- ❌ Block trading

**Account States**:
```
Active → Breached (detected) → Failed (human-confirmed)
Active → Passed → Payout Review → Payout Approved (human)
```

Human confirmation required for all terminal state transitions.

---

### 1.5 Trader Dashboard

**Challenge Progress View**:
- Real-time equity and P&L display
- Visual drawdown tracker with threshold line
- Progress toward profit target (percentage)
- Trading days counter

**Rule Status Panel**:
- Checklist of all active rules (pass/warning/breach status)
- Current position relative to limits
- **Proactive warnings** when approaching thresholds (80% of limit)

**Account Lifecycle**:
- Current stage indicator
- Status messages for any holds or reviews
- Clear, transparent communication

**Trading Metrics**:
- Win rate, profit factor display
- Trade history with filtering
- Performance charts

---

### 1.6 Risk Officer Console

**Live Monitoring Dashboard**:
- All accounts with risk score indicators (color-coded)
- Filter by score thresholds, account state
- Pending flags queue

**Account Investigation**:
- Deep-dive into trader activity
- Trade-by-trade analysis
- Score change history with reasons
- Device/IP linking information

**Flag Management**:
- Queue of accounts requiring review
- Actions available: **Clear Flag | Extend Review | Escalate to Admin**
- Required documentation for all decisions
- Complete audit trail

**⚠️ No "Suspend" or "Ban" buttons for Risk Officers** — escalation to Admin only.

---

### 1.7 Admin Panel

**User Management**:
- View all users and roles
- Assign/revoke roles
- Account status management (with required documentation)

**Payout Approval Workflow**:
1. Trader requests payout
2. System runs score checks → Advisory flags
3. Risk Officer reviews (if flagged)
4. **Admin approves or requests more info**
5. Payout processed

**No automated payout denial. Ever.**

**Cohort Configuration**:
- Create new rule sets for FUTURE users only
- View existing cohorts (read-only once assigned)
- Version history

**Intake Pause Switch**:
- Global toggle to pause new account creation
- Per-cohort intake throttling
- This is the PRIMARY risk control mechanism

---

### 1.8 Notification System

**Trader Notifications**:
- Warning alerts (approaching limits)
- Rule breach detection (with explanation)
- Account under review (with expected timeline)
- Payout status updates

**Internal Alerts**:
- New flags for review
- Score threshold crossings
- Escalations

**All notifications are informational. None trigger automatic actions.**

---

### 1.9 Audit System

**Every action logged**:
- Who (user ID + role)
- What (action type + details)
- When (timestamp)
- Why (reason/documentation)
- Result (outcome)

**Immutable logs** — no deletion, no modification.

**Exportable for compliance review.**

---

## Deferred to Phase 2+ (Do NOT Build Now)

| Feature | Reason to Defer |
|---------|-----------------|
| Order rejection | Violates human-in-the-loop |
| Auto-lock/auto-ban | Violates human-in-the-loop |
| Correlation trade blocking | Overreach for SIM |
| Hedging triggers | No market exposure |
| Scenario analysis tools | Complexity creep |
| ML feature pipelines | Premature optimization |
| Graph visualizations | Nice-to-have, not MVP |
| Sharpe ratio calculations | Analytics, not core risk |
| Platform exposure dashboards | Firm-level, not MVP |

---

## Litmus Test Before Any Feature

> "Could this feature automatically take money, deny money, or stop trading without a human explicitly approving it?"

If **YES** → Do not build.
If **NO** → Safe to implement.

---

## Technology Stack

- **Frontend**: React + TypeScript + Tailwind CSS + shadcn/ui
- **Backend**: External Supabase
  - PostgreSQL with RLS
  - Edge Functions for webhooks
  - Real-time subscriptions for dashboards
- **Charts**: Recharts
- **State**: React Query
- **Auth**: Supabase Auth with role-based access (roles in separate table)

---

## Implementation Order

1. **Week 1**: Database schema + Auth + Role system
2. **Week 2**: Rule engine (detection only) + Account state machine
3. **Week 3**: Trader Dashboard + Warnings
4. **Week 4**: Risk Console + Flag management + Audit logs

---

## Success Criteria for Phase 1

✅ Traders see real-time progress and warnings
✅ Rule breaches detected instantly, logged immutably
✅ Risk officers can review flagged accounts
✅ Admins approve all payouts manually
✅ Complete audit trail for every decision
✅ No automated denials, locks, or rejections
✅ Intake pause switch functional

This is the "Detection, Not Domination" foundation. Phase 2 adds intelligence. Phase 3 adds scale.
