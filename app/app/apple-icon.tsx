import {ImageResponse} from 'next/og';

// Larger touch-icon for iOS home-screen / pinned tabs. Same palette as the
// favicon, just scaled up so the type doesn't pixelate.
export const size = {width: 180, height: 180};
export const contentType = 'image/png';

export default function AppleIcon() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: 180,
                    height: 180,
                    background: '#FFFFFF',
                    color: '#111111',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'monospace',
                    fontSize: 88,
                    fontWeight: 600,
                    letterSpacing: -4,
                    position: 'relative',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        bottom: 22,
                        left: 28,
                        right: 28,
                        height: 12,
                        background: '#111111',
                    }}
                />
                <div style={{display: 'flex'}}>111</div>
            </div>
        ),
        size,
    );
}
