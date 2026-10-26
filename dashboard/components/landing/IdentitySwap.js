// A Discord-style message that switches from the default ZiGBoT name and
// picture to an example custom one and back. CSS only (landing.css); with
// reduced motion it simply shows the custom version. Decorative: the card
// text says the same thing. The APP tag never changes.
export default function IdentitySwap() {
    return (
        <div className="l-idswap" aria-hidden="true">
            <span className="l-idswap-avatars">
                <img className="l-idswap-av l-idswap-a" src="/zigbot.png" alt="" width="32" height="32" />
                <span className="l-idswap-av l-idswap-b l-idswap-custom">☕</span>
            </span>
            <span className="l-idswap-body">
                <span className="l-idswap-head">
                    <span className="l-idswap-names">
                        <span className="l-idswap-a">ZiGBoT</span>
                        <span className="l-idswap-b">Captain Chai</span>
                    </span>
                    <span className="l-idswap-app">APP</span>
                </span>
                <span className="l-idswap-msg">gm chat ☀️ same bot, new fit</span>
            </span>
        </div>
    );
}
