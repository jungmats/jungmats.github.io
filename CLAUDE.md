# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a static website for ElevIQ Solutions hosted on GitHub Pages with a custom domain (eleviq.solutions). The site is a simple marketing page for the company and its upcoming MediChecker app.

## Architecture

### Structure
- **Static HTML site** with no build process or package manager
- **Two main pages:**
  - `index.html` - Main landing page with company info and product announcement
  - `privacy.html` - Privacy policy for the MediChecker app
- **Shared styling:** Both pages use `styles.css` with CSS custom properties for theming
- **Assets:** Multiple logo variations (`eleviq_logo_v1.*.png`) and app icon (`icon.png`)
- **Custom domain:** Configured via `CNAME` file pointing to `eleviq.solutions`

### Design System
- CSS custom properties defined in `:root` for consistent theming:
  - Primary colors: `--cyan`, `--petrol`, `--blue`, `--yellow`
  - Layout uses flexbox with sidebar navigation and main content area
  - Mobile-responsive with `min-height: 100%` for full-height layouts

## Development

### Local Development
To preview the site locally, use Python's built-in HTTP server:
```bash
python3 -m http.server 8000
```
Then visit http://localhost:8000

### Deployment
Changes pushed to the `main` branch are automatically deployed to GitHub Pages and served at eleviq.solutions.

### Key Files
- Logo: Currently using `eleviq_logo_v1.5.png` (referenced in both HTML files)
- Contact email: `hello@eleviq.solutions`
- Privacy contact: `privacy@eleviq.solutions`
- Company identifier: Numéro Siren: 940258254

### Important Notes
- No JavaScript framework or build tools
- Direct HTML/CSS editing
- When updating logos, update both `index.html:13` and `privacy.html:14`
- Sidebar navigation must be kept in sync between pages
