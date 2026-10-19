/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the map instance is intentionally long-lived

  /**
   * A signature the service worker can check before caching a page.
   *
   * Free hosting spins the service down when idle, and while it wakes the host
   * serves ITS OWN holding page from our domain. That page is same-origin and
   * may well come back 200, which is everything the service worker was
   * checking for — so it could be cached as the app shell and then served,
   * offline, forever after. "Application loading" with no application behind
   * it. Only pages carrying this header are ours, and only ours get cached.
   */
  async headers() {
    return [
      { source: '/:path*', headers: [{ key: 'x-campus-bus', value: 'app' }] },
      // The basemap, its fonts and icons. The map file's name carries the date
      // of the OpenStreetMap data, so a given URL never changes: cache it for
      // a year and a phone downloads each piece once.
      { source: '/maps/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ];
  },
};

export default nextConfig;
