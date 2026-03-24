#!/usr/bin/env python3
"""
Parse Python source via stdlib ast and emit imports/exports in JSON.

Supports three modes:

1. Extract mode (default):
   Input: { "path": "relative/path.py", "content": "<file text>" }
   Output: { "path", "imports", "exports" }

2. Batch extract mode:
   Input: { "mode": "batch_extract", "items": [{ "path": "...", "content": "..." }, ...] }
   Output: { "results": [{ "path", "imports", "exports" }, ...] }

3. Find scopes mode:
   Input: { "mode": "find_scopes", "content": "<file text>", "lines": [1, 5, 10], "scope_mode": "function"|"class" }
   Output: { "scopes": { "1": {...}|null, "5": {...}|null, ... } }
"""
import ast
import json
import sys
from typing import Any, Dict, List, Optional, Tuple


def _const_str(node: ast.AST) -> Optional[str]:
    """Extract string value from Constant node."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _extract_all(tree: ast.Module) -> Optional[List[str]]:
    """Extract __all__ = ["a", "b"] if it's a literal list/tuple of strings."""
    for n in tree.body:
        if not isinstance(n, ast.Assign):
            continue
        for t in n.targets:
            if isinstance(t, ast.Name) and t.id == "__all__":
                if isinstance(n.value, (ast.List, ast.Tuple)):
                    vals = []
                    for e in n.value.elts:
                        s = _const_str(e)
                        if s is None:
                            return None  # Non-literal element, can't determine
                        vals.append(s)
                    return vals
    return None


def _is_toplevel(node: ast.AST, tree: ast.Module) -> bool:
    """Check if a node is at module top-level (in tree.body)."""
    return node in tree.body


def _get_scope_kind(node: ast.AST) -> str:
    """Get the kind of scope a node represents."""
    if isinstance(node, ast.ClassDef):
        return "class"
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        # Check if it's a method (inside a class)
        return "function"  # Will be refined to "method" based on parent
    return "unknown"


def _find_all_scopes(tree: ast.Module) -> List[Dict[str, Any]]:
    """
    Find all function/method/class scopes in the AST.
    
    Returns list of:
      { "name", "kind", "start_line", "end_line", "parent_class": str|None }
    """
    scopes = []
    
    # Track class context for methods
    def visit(node: ast.AST, parent_class: Optional[str] = None):
        if isinstance(node, ast.ClassDef):
            scopes.append({
                "name": node.name,
                "kind": "class",
                "start_line": node.lineno,
                "end_line": node.end_lineno or node.lineno,
                "parent_class": parent_class,
            })
            # Visit children with this class as parent
            for child in ast.iter_child_nodes(node):
                visit(child, parent_class=node.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "method" if parent_class else "function"
            scopes.append({
                "name": node.name,
                "kind": kind,
                "start_line": node.lineno,
                "end_line": node.end_lineno or node.lineno,
                "parent_class": parent_class,
            })
            # Visit nested functions (no class context)
            for child in ast.iter_child_nodes(node):
                visit(child, parent_class=None)
        else:
            # Continue visiting children
            for child in ast.iter_child_nodes(node):
                visit(child, parent_class=parent_class)
    
    for node in tree.body:
        visit(node)
    
    return scopes


def _find_enclosing_scope(
    scopes: List[Dict[str, Any]],
    line: int,
    scope_mode: str
) -> Optional[Dict[str, Any]]:
    """
    Find the enclosing scope for a given line number.
    
    Args:
        scopes: List of scope dictionaries
        line: 1-indexed line number
        scope_mode: "function" (innermost) or "class" (prefer containing class)
    
    Returns:
        Scope dict or None if line is at module level
    """
    # Find all scopes containing this line
    containing = [
        s for s in scopes
        if s["start_line"] <= line <= s["end_line"]
    ]
    
    if not containing:
        return None
    
    # Sort by size (smallest = innermost)
    containing.sort(key=lambda s: s["end_line"] - s["start_line"])
    
    if scope_mode == "function":
        # Return innermost function/method
        for s in containing:
            if s["kind"] in ("function", "method"):
                return s
        # Fall back to innermost scope
        return containing[0]
    elif scope_mode == "class":
        # Return containing class if exists
        for s in containing:
            if s["kind"] == "class":
                return s
        # Fall back to innermost scope
        return containing[0]
    
    return containing[0]


def find_enclosing_scopes(
    content: str,
    lines: List[int],
    scope_mode: str = "function"
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Find enclosing scope for each line number.
    
    Args:
        content: Python source code
        lines: List of 1-indexed line numbers
        scope_mode: "function" (innermost) or "class" (include containing class)
    
    Returns:
        Dict mapping line number (as string) to scope info or None
    """
    result: Dict[str, Optional[Dict[str, Any]]] = {str(ln): None for ln in lines}
    
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return result
    
    scopes = _find_all_scopes(tree)
    
    for ln in lines:
        scope = _find_enclosing_scope(scopes, ln, scope_mode)
        if scope:
            result[str(ln)] = {
                "name": scope["name"],
                "kind": scope["kind"],
                "start_line": scope["start_line"],
                "end_line": scope["end_line"],
            }
    
    return result


def extract(file_path: str, content: str) -> Dict[str, Any]:
    """
    Extract imports and exports from Python source.
    
    Returns empty results on syntax error rather than crashing the pipeline.
    """
    empty_result = {
        "path": file_path,
        "imports": [],
        "exports": {
            "functions": [],
            "classes": [],
            "assignments": [],
            "all": None,
        },
    }

    try:
        tree = ast.parse(content, filename=file_path)
    except SyntaxError:
        return empty_result

    imports: List[Dict[str, Any]] = []
    funcs: List[str] = []
    classes: List[str] = []
    assigns: List[str] = []

    # Walk entire tree for imports (can appear anywhere)
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                imports.append({
                    "kind": "import",
                    "module": a.name,
                    "name": None,
                    "asname": a.asname,
                    "level": 0,
                })
        elif isinstance(n, ast.ImportFrom):
            for a in n.names:
                imports.append({
                    "kind": "from",
                    "module": n.module,
                    "name": a.name,
                    "asname": a.asname,
                    "level": n.level or 0,
                })

    # Only collect top-level definitions as exports
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not n.name.startswith("_"):
                funcs.append(n.name)
        elif isinstance(n, ast.ClassDef):
            if not n.name.startswith("_"):
                classes.append(n.name)
        elif isinstance(n, ast.Assign):
            # Top-level ALLCAPS assignments (constants)
            for t in n.targets:
                if isinstance(t, ast.Name):
                    name = t.id
                    # Include if ALLCAPS or in __all__
                    if name.isupper() or (name and not name.startswith("_")):
                        if name.isupper():
                            assigns.append(name)

    return {
        "path": file_path,
        "imports": imports,
        "exports": {
            "functions": sorted(set(funcs)),
            "classes": sorted(set(classes)),
            "assignments": sorted(set(assigns)),
            "all": _extract_all(tree),
        },
    }


def main() -> None:
    """Read JSON from stdin, dispatch to appropriate mode, write JSON to stdout."""
    data = json.load(sys.stdin)
    mode = data.get("mode", "extract")

    if mode == "find_scopes":
        # Find enclosing scopes for given line numbers
        content = data.get("content", "")
        lines = data.get("lines", [])
        scope_mode = data.get("scope_mode", "function")
        scopes = find_enclosing_scopes(content, lines, scope_mode)
        json.dump({"scopes": scopes}, sys.stdout)
    elif mode == "batch_extract":
        # Extract imports/exports for multiple files in one invocation
        items = data.get("items", [])
        results = []
        for item in items:
            result = extract(item.get("path", ""), item.get("content", ""))
            results.append(result)
        json.dump({"results": results}, sys.stdout)
    else:
        # Default: extract imports/exports
        out = extract(data.get("path", ""), data.get("content", ""))
        json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
