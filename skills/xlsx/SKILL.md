---
name: "xlsx"
description: "Use this skill any time a spreadsheet file is the primary input or output: open, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular data formats. Trigger especially when the user references a spreadsheet file and wants something done to it or produced from it, including cleaning or restructuring messy tabular data (malformed rows, misplaced headers, junk rows) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, script, or database pipeline. For merely reading document content use native document_read."
---

# Requirements for Outputs

Design guidance (spreadsheets section) in `../document-authoring/design.md`; verification gates in `../document-authoring/qa.md`. **All relative script paths in this skill resolve from this skill's directory** (the one containing this SKILL.md).

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative values)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"

# XLSX creation, editing, and analysis

## Overview

Different tools and workflows apply to different tasks.

## Important Requirements

**LibreOffice Required for Formula Recalculation**: check `soffice` is on PATH before promising recalculated values — if missing, say so explicitly (formulas ship uncomputed). `scripts/recalc.py` automatically configures LibreOffice on first run, including in sandboxes where Unix sockets are restricted (handled by `../document-authoring/scripts/office/soffice.py`).

## Data analysis

For data analysis and visualization use **pandas**. For inspecting a document's content (not its data), use native `document_read`.

```python
import pandas as pd

df = pd.read_excel('file.xlsx')            # default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # all sheets as dict

df.head(); df.info(); df.describe()        # analyze
df.to_excel('output.xlsx', index=False)    # write
```

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```python
total = df['Sales'].sum()
sheet['B10'] = total           # hardcodes 5000
```

### ✅ CORRECT - Using Excel Formulas
```python
sheet['B10'] = '=SUM(B2:B9)'   # let Excel calculate
sheet['C5'] = '=(C4-C2)/C2'    # growth rate as formula
sheet['D20'] = '=AVERAGE(D2:D19)'
```

This applies to ALL calculations — totals, percentages, ratios, differences. The spreadsheet must recalculate when source data changes.

## Common Workflow
1. **Choose tool**: pandas for data, openpyxl for formulas/formatting
2. **Create/Load**: Create new workbook or load existing file
3. **Modify**: Add/edit data, formulas, and formatting
4. **Save**: Write to file
5. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: `python scripts/recalc.py output.xlsx`
6. **Verify and fix any errors**:
   - The script returns JSON with error details
   - If `status` is `errors_found`, check `error_summary` for error types and locations
   - Fix the identified errors and recalculate again
   - Common errors: `#REF!` invalid references · `#DIV/0!` division by zero · `#VALUE!` wrong data type · `#NAME?` unrecognized formula name

### Creating new Excel files

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active
sheet['A1'] = 'Hello'
sheet.append(['Row', 'of', 'data'])
sheet['B2'] = '=SUM(A1:A10)'                     # formula
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')
sheet.column_dimensions['A'].width = 20
wb.save('output.xlsx')
```

### Editing existing Excel files

```python
from openpyxl import load_workbook

wb = load_workbook('existing.xlsx')        # preserves formulas and formatting
sheet = wb['SheetName']
sheet['A1'] = 'New Value'
sheet.insert_rows(2)
wb.create_sheet('NewSheet')['A1'] = 'Data'
wb.save('modified.xlsx')
```

## Recalculating formulas

Excel files created or modified by openpyxl contain formulas as strings but not calculated values. Use `scripts/recalc.py`:

```bash
python scripts/recalc.py <excel_file> [timeout_seconds]
```

The script: sets up a LibreOffice macro on first run; recalculates all formulas in all sheets; scans ALL cells for Excel errors; returns JSON with detailed error locations and counts (Linux and macOS).

## Formula Verification Checklist

- [ ] **Test 2-3 sample references**: pull correct values before building the full model
- [ ] **Column mapping**: Excel columns match (column 64 = BL, not BK)
- [ ] **Row offset**: Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)
- [ ] **NaN handling**: check nulls with `pd.notna()`
- [ ] **Division by zero**: check denominators (#DIV/0!)
- [ ] **Wrong references**: verify all references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: correct format (Sheet1!A1)
- [ ] **Start small**: test formulas on 2-3 cells before applying broadly
- [ ] **Edge cases**: zero, negative, very large values

## Interpreting scripts/recalc.py Output
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,
  "total_formulas": 42,
  "error_summary": {             // only present if errors found
    "#REF!": { "count": 2, "locations": ["Sheet1!B5", "Sheet1!C10"] }
  }
}
```

## Best Practices

### Library Selection
- **pandas**: data analysis, bulk operations, simple data export
- **openpyxl**: complex formatting, formulas, Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 = A1)
- Use `data_only=True` to read calculated values — **warning**: if opened with `data_only=True` and saved, formulas are replaced with values and permanently lost
- For large files: `read_only=True` for reading, `write_only=True` for writing
- Formulas are preserved but not evaluated — use `scripts/recalc.py` to update values

### Working with pandas
- Specify data types to avoid inference issues: `pd.read_excel('file.xlsx', dtype={'id': str})`
- For large files, read specific columns: `usecols=['A', 'C', 'E']`
- Handle dates: `parse_dates=['date_column']`

## Code Style Guidelines
When generating Python code for Excel operations: minimal, concise code without unnecessary comments or print statements. **For Excel files themselves**: comment cells with complex formulas or important assumptions; document data sources for hardcoded values; note key calculations and model sections.
