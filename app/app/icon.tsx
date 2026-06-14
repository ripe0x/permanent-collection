import {ImageResponse} from 'next/og';

// Next 15 auto-generates the favicon from this file. 32×32 mark: ink "111"
// on the bg color, accent slab underneath. Same palette as the site so the
// browser tab feels in-voice.
export const size = {width: 64, height: 64};
export const contentType = 'image/png';

export default function Icon() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: 64,
                    height: 64,
                    background: '#FFFFFF',
                    color: '#111111',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'monospace',
                    fontSize: 30,
                    fontWeight: 600,
                    letterSpacing: -1.5,
                    position: 'relative',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        bottom: 6,
                        left: 8,
                        right: 8,
                        height: 4,
                        background: '#111111',
                    }}
                />
                <div style={{display: 'flex'}}>111</div>
            </div>
        ),
        size,
    );
}
