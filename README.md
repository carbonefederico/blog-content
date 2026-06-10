# blog-content

This is the public GitHub Pages repository for FC Tech, built with the Chirpy Jekyll theme.

Only published articles belong here. Drafting, outlining, and review happen in the private `blogger-agent` repository, and published content is synced into this repository.

## Local Development

Run the site locally with:

```bash
bundle install
bundle exec jekyll serve
```

The expected Pages URL for this project site is:

`https://carbonefederico.github.io/blog-content/`

## Structure

- `index.html` uses Chirpy's home layout.
- `_tabs/` contains the sidebar pages such as Categories, Tags, Archives, and About.
- `_posts/` contains published Markdown posts copied from `blogger-agent`.

## Notes

- This is a GitHub Pages project site, so `_config.yml` uses `url: "https://carbonefederico.github.io"` and `baseurl: "/blog-content"`.
- The overall layout, sidebar, post navigation, search UI, tags, archives, and technical-blog styling come from Chirpy.
