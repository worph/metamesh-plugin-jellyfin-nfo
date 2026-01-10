# MetaMesh Plugin: Jellyfin NFO

A MetaMesh plugin that parses Jellyfin/Kodi NFO metadata files.

## Description

This plugin parses XML-based NFO metadata files used by Jellyfin, Kodi, and other media managers. It extracts:

- **Movie/TV show metadata**: title, year, rating, plot
- **External IDs**: IMDB, TMDB, AniDB
- **Categories**: genres, studios, tags

The plugin looks for:
- `{filename}.nfo` - File-specific metadata
- `tvshow.nfo` - Series-level metadata in the same directory

## Metadata Fields

| Field | Description |
|-------|-------------|
| `videoType` | `movie` or `tvshow` |
| `originalTitle` | Original title from NFO |
| `season` | Season number |
| `episode` | Episode number |
| `movieYear` | Release year |
| `rating` | User rating |
| `imdbid` | IMDB ID |
| `tmdbid` | TMDB ID |
| `anidbid` | AniDB ID |
| `plot/{lang}` | Plot description (language detected) |
| `genres` | Genre set |
| `studio` | Production studio set |
| `tags` | Tag set |

## Dependencies

- Requires `file-info` and `filename-parser` plugins

## Configuration

No configuration required.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/manifest` | GET | Plugin manifest |
| `/configure` | POST | Update configuration |
| `/process` | POST | Process a file |

## Running Locally

```bash
npm install
npm run build
npm start
```

## Docker

```bash
docker build -t metamesh-plugin-jellyfin-nfo .
docker run -p 8080:8080 metamesh-plugin-jellyfin-nfo
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |

## License

MIT
