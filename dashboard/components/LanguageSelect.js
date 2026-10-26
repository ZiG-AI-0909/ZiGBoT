'use client';

import { useEffect, useId, useRef, useState } from 'react';

// Animated single-choice dropdown (button + listbox, WAI-ARIA pattern).
// Keyboard: Enter/Space/ArrowDown/ArrowUp open; arrows, Home/End and first
// letter move; Enter/Space choose; Escape/Tab close. Tap or click works the
// same on mobile. The list stays in the DOM (hidden when closed) so it can
// fade/slide in; styles in globals.css (.choice-*).
export default function LanguageSelect({ id, label, help, options, value, onChange, notice = null }) {
    const uid = useId();
    const listId = `${id}-list-${uid}`;
    const buttonRef = useRef(null);
    const listRef = useRef(null);
    const wrapRef = useRef(null);
    const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(selectedIndex);
    const current = options[selectedIndex];

    useEffect(() => {
        if (!open) return undefined;
        const close = (event) => {
            if (!wrapRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', close);
        return () => document.removeEventListener('pointerdown', close);
    }, [open]);

    useEffect(() => {
        if (open) listRef.current?.focus({ preventScroll: true });
    }, [open]);

    function show(index = selectedIndex) {
        setActive(index);
        setOpen(true);
    }
    function choose(index) {
        onChange(options[index].value);
        setOpen(false);
        buttonRef.current?.focus();
    }

    function onButtonKey(event) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            show(event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex);
        }
    }

    function onListKey(event) {
        const last = options.length - 1;
        if (event.key === 'ArrowDown') setActive((i) => Math.min(last, i + 1));
        else if (event.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
        else if (event.key === 'Home') setActive(0);
        else if (event.key === 'End') setActive(last);
        else if (event.key === 'Enter' || event.key === ' ') choose(active);
        else if (event.key === 'Escape') {
            setOpen(false);
            buttonRef.current?.focus();
        } else if (event.key === 'Tab') {
            setOpen(false);
            return;
        } else if (event.key.length === 1) {
            const next = options.findIndex((o) => o.label.toLowerCase().startsWith(event.key.toLowerCase()));
            if (next >= 0) setActive(next);
            else return;
        } else {
            return;
        }
        event.preventDefault();
    }

    return (
        <div className="field">
            <span className="label" id={`${id}-label`}>{label}</span>
            {help ? <span className="help" id={`${id}-help`}>{help}</span> : null}
            <div className="choice" ref={wrapRef} data-open={open ? 'true' : 'false'}>
                <button
                    ref={buttonRef}
                    id={id}
                    type="button"
                    className="choice-button"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-labelledby={`${id}-label ${id}`}
                    aria-describedby={help ? `${id}-help` : undefined}
                    onClick={() => (open ? setOpen(false) : show())}
                    onKeyDown={onButtonKey}
                >
                    <span className="choice-icon" aria-hidden="true">{current?.icon}</span>
                    <span className="choice-text">{current?.label}</span>
                    <span className="choice-caret" aria-hidden="true">▾</span>
                </button>
                <ul
                    ref={listRef}
                    id={listId}
                    className="choice-list"
                    role="listbox"
                    tabIndex={-1}
                    aria-labelledby={`${id}-label`}
                    aria-activedescendant={open ? `${listId}-${active}` : undefined}
                    aria-hidden={!open}
                    onKeyDown={onListKey}
                >
                    {options.map((option, index) => (
                        <li
                            key={option.value}
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={index === selectedIndex}
                            className={`choice-option ${index === active ? 'is-active' : ''}`}
                            onPointerEnter={() => setActive(index)}
                            onClick={() => choose(index)}
                        >
                            <span className="choice-icon" aria-hidden="true">{option.icon}</span>
                            <span>
                                <span className="choice-text">{option.label}</span>
                                {option.help ? <span className="help choice-help">{option.help}</span> : null}
                            </span>
                            {index === selectedIndex ? <span className="choice-check" aria-hidden="true">✓</span> : null}
                        </li>
                    ))}
                </ul>
            </div>
            {notice ? <span className="notice choice-notice" role="status">{notice}</span> : null}
        </div>
    );
}
