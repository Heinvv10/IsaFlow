# /kb - Knowledge Base Update

Update the ISAFlow knowledge base by scanning modules, services, API routes, and pages — then refreshing context files.

## Usage

```
/kb              # Full scan and update
/kb status       # Show KB status only
/kb [module]     # Update specific module (accounting, payroll)
```

## What This Does

1. **Scan Modules** - Find all `src/modules/*/` directories
2. **Scan Services** - Find all service files in `src/modules/*/services/`
3. **Scan API Routes** - Count and categorize `pages/api/accounting/` routes
4. **Scan Pages** - Count and categorize `pages/accounting/` pages
5. **Check Coverage** - Identify modules/services missing `.claude.md`
6. **Generate Context** - Create `.claude.md` for missing modules
7. **Consolidate Learnings** - Move `.claude-learnings.md` entries to permanent KB
8. **Update Memory** - Sync findings to `.claude/projects/*/memory/`

## Execution Steps

### Step 1: Scan Project Structure
```bash
# Count modules
ls -d src/modules/*/ | wc -l

# Count services
find src/modules -name "*Service.ts" -o -name "*service.ts" | wc -l

# Count API routes
find pages/api/accounting -name "*.ts" | wc -l

# Count pages
find pages/accounting -name "*.tsx" | wc -l

# Count DB migrations
ls scripts/migrations/sql/*.sql | wc -l
```

### Step 2: Check Module Coverage
```bash
# List modules with .claude.md
find src/modules -maxdepth 2 -name ".claude.md" | wc -l

# List modules WITHOUT .claude.md
for dir in src/modules/*/; do
  name=$(basename "$dir")
  if [ ! -f "$dir/.claude.md" ]; then
    echo "MISSING: $name"
  fi
done
```

### Step 3: For Each Missing Module
Generate `.claude.md` using the template at `.claude/templates/module-claude-md.template`:
- Extract purpose from code structure
- List key service files with their exported functions
- Identify API endpoints from `pages/api/`
- Note DB tables from migrations
- Document critical rules and patterns

### Step 4: Service Inventory
For each service file, verify it has:
- Proper TypeScript types (no `any` on public interfaces)
- Company ID scoping (multi-tenant safety)
- Error handling (no empty catches)
- Consistent patterns (`sql` tagged templates, `apiResponse` helpers)

### Step 5: Consolidate Learnings
Check for `.claude-learnings.md` files:
```bash
find src/modules -name ".claude-learnings.md" -exec echo "Found: {}" \;
```
Move entries >7 days old to module's `.claude.md` under "## Learnings" section.

### Step 6: Update Memory Index
Sync key findings to the auto-memory system at:
`/home/hein/.claude/projects/-home-hein-Workspace-Accounting/memory/`

Update `project_modules.md` with current module/service/API/page counts.

### Step 7: Report Results
```
╔══════════════════════════════════════════════════════════════╗
║                    KB UPDATE COMPLETE                        ║
╠══════════════════════════════════════════════════════════════╣
║ Modules:                 N                                   ║
║ Services:                N                                   ║
║ API Routes:              N                                   ║
║ Pages:                   N                                   ║
║ DB Migrations:           N                                   ║
║ With .claude.md:         N / N (XX%)                         ║
║ Learnings consolidated:  N                                   ║
║                                                              ║
║ Coverage gaps:                                               ║
║   ❌ [module] — missing .claude.md                           ║
║   ⚠️  [service] — missing company_id scoping                ║
║                                                              ║
║ Sage parity status:                                          ║
║   ✅ Company Settings (36/36 features)                       ║
║   ✅ Customer form (Sage-parity fields)                      ║
║   ✅ Sales Orders, Purchase Orders, Items                    ║
║   ⏳ [remaining gaps from project_sage_gaps.md]              ║
╚══════════════════════════════════════════════════════════════╝
```

## Key Files

| File | Purpose |
|------|---------|
| `src/modules/*/.claude.md` | Module context files |
| `src/modules/*/.claude-learnings.md` | Auto-captured learnings |
| `.claude/templates/module-claude-md.template` | Module doc template |
| `.claude/projects/*/memory/project_sage_gaps.md` | Sage parity tracking |
| `.claude/projects/*/memory/project_sage_full_audit.md` | Full feature audit |
| `.claude/projects/*/memory/project_modules.md` | Module inventory |

## Sage Parity Tracking

When running /kb, always cross-reference against the Sage gap lists:
- `memory/project_sage_gaps.md` — 36 company settings gaps
- `memory/project_sage_full_audit.md` — Full page/form/field audit

Report which gaps have been closed since last scan.
