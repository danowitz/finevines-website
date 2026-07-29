/* @ds-bundle: {"format":3,"namespace":"FineVinesDesignSystem_d87fe4","components":[{"name":"FacetGroup","sourcePath":"components/catalog/FacetGroup.jsx"},{"name":"ProducerCard","sourcePath":"components/catalog/ProducerCard.jsx"},{"name":"SpecTable","sourcePath":"components/catalog/SpecTable.jsx"},{"name":"WineCard","sourcePath":"components/catalog/WineCard.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Eyebrow","sourcePath":"components/core/Eyebrow.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"Select","sourcePath":"components/core/Select.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"}],"sourceHashes":{"components/catalog/FacetGroup.jsx":"75de3e277881","components/catalog/ProducerCard.jsx":"ed04073fe21e","components/catalog/SpecTable.jsx":"94c61f581eee","components/catalog/WineCard.jsx":"db55234dcb7e","components/core/Badge.jsx":"8120b5698a38","components/core/Button.jsx":"2663ce163ba2","components/core/Eyebrow.jsx":"96f8f15d8f91","components/core/Input.jsx":"017d6298bf1a","components/core/Select.jsx":"fcb150d5ce65","components/core/Tag.jsx":"95b5c5ea95d3","ui_kits/website/Footer.jsx":"07cba0c042d3","ui_kits/website/Header.jsx":"62f682fc0d21","ui_kits/website/HomeScreen.jsx":"1790b3f21509","ui_kits/website/MiscScreens.jsx":"c1e1bca8c9b4","ui_kits/website/Parts.jsx":"73ff9c8949ae","ui_kits/website/PortfolioScreen.jsx":"dc18ef0e84e4","ui_kits/website/ProducerScreen.jsx":"06c08e187df3","ui_kits/website/ProductScreen.jsx":"803a8ca0c325","ui_kits/website/data.js":"6a5d13b31b7c"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.FineVinesDesignSystem_d87fe4 = window.FineVinesDesignSystem_d87fe4 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/catalog/FacetGroup.jsx
try { (() => {
/* Faceted filter group for the Portfolio rail. Renders a titled section with
   checkbox-style options and counts; controlled via selected/onToggle. */
function FacetGroup({
  title,
  options = [],
  selected = [],
  onToggle,
  collapsible = true,
  defaultOpen = true
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const isOpen = collapsible ? open : true;
  return React.createElement('section', {
    style: {
      borderBottom: '1px solid var(--border-hairline)',
      padding: '14px 0',
      fontFamily: 'var(--font-ui)'
    }
  }, React.createElement('button', {
    onClick: () => collapsible && setOpen(o => !o),
    style: {
      all: 'unset',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      cursor: collapsible ? 'pointer' : 'default',
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--text-strong)'
    }
  }, title, collapsible && React.createElement('span', {
    style: {
      color: 'var(--brass-600)',
      fontSize: '11px',
      transform: isOpen ? 'rotate(180deg)' : 'none',
      transition: 'transform var(--dur-fast)'
    }
  }, '▾')), isOpen && React.createElement('ul', {
    style: {
      listStyle: 'none',
      margin: '12px 0 2px',
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '9px'
    }
  }, options.map(opt => {
    const label = typeof opt === 'string' ? opt : opt.label;
    const count = typeof opt === 'string' ? null : opt.count;
    const checked = selected.includes(label);
    return React.createElement('li', {
      key: label
    }, React.createElement('label', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        cursor: 'pointer',
        fontSize: '14px',
        color: checked ? 'var(--text-strong)' : 'var(--text-body)'
      }
    }, React.createElement('span', {
      onClick: e => {
        e.preventDefault();
        onToggle && onToggle(label);
      },
      style: {
        width: '15px',
        height: '15px',
        flex: 'none',
        border: `1.5px solid ${checked ? 'var(--bordeaux-700)' : 'var(--border-strong)'}`,
        background: checked ? 'var(--bordeaux-700)' : 'transparent',
        borderRadius: '2px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--parchment-50)',
        fontSize: '10px',
        lineHeight: 1,
        transition: 'all var(--dur-fast) var(--ease-standard)'
      }
    }, checked ? '✓' : ''), React.createElement('input', {
      type: 'checkbox',
      checked,
      onChange: () => onToggle && onToggle(label),
      style: {
        position: 'absolute',
        opacity: 0,
        width: 0,
        height: 0
      }
    }), React.createElement('span', {
      style: {
        flex: 1
      }
    }, label), count != null && React.createElement('span', {
      style: {
        color: 'var(--text-faint)',
        fontSize: '12.5px',
        fontVariantNumeric: 'tabular-nums'
      }
    }, count)));
  })));
}
Object.assign(__ds_scope, { FacetGroup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/catalog/FacetGroup.jsx", error: String((e && e.message) || e) }); }

// components/catalog/SpecTable.jsx
try { (() => {
/* Two-column tech-spec table for a product detail page. rows = [[label,value],…] */
function SpecTable({
  rows = [],
  title
}) {
  return React.createElement('div', {
    style: {
      fontFamily: 'var(--font-ui)'
    }
  }, title && React.createElement('div', {
    style: {
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--brass-700)',
      marginBottom: '10px'
    }
  }, title), React.createElement('dl', {
    style: {
      margin: 0,
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      columnGap: '24px'
    }
  }, rows.flatMap(([label, value], i) => [React.createElement('dt', {
    key: 'l' + i,
    style: {
      fontSize: '14px',
      color: 'var(--text-muted)',
      padding: '11px 0',
      borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)'
    }
  }, label), React.createElement('dd', {
    key: 'v' + i,
    style: {
      margin: 0,
      fontSize: '14px',
      fontWeight: 500,
      color: 'var(--text-strong)',
      textAlign: 'right',
      padding: '11px 0',
      borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
      fontVariantNumeric: 'tabular-nums'
    }
  }, value)])));
}
Object.assign(__ds_scope, { SpecTable });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/catalog/SpecTable.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function Badge({
  children,
  tone = 'bordeaux',
  solid = false
}) {
  const map = {
    bordeaux: 'var(--bordeaux-700)',
    brass: 'var(--brass-600)',
    vine: 'var(--vineyard-700)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)',
    info: 'var(--info)'
  };
  const c = map[tone] || map.bordeaux;
  const style = solid ? {
    background: c,
    color: 'var(--parchment-50)',
    border: `1px solid ${c}`
  } : {
    background: 'transparent',
    color: c,
    border: `1px solid ${c}`
  };
  return React.createElement('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      fontFamily: 'var(--font-ui)',
      fontSize: '10px',
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      padding: '3px 8px',
      borderRadius: 'var(--radius-sm)',
      lineHeight: 1.2,
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function Button({
  children,
  variant = 'primary',
  size = 'md',
  iconLeft = null,
  iconRight = null,
  fullWidth = false,
  disabled = false,
  as = 'button',
  ...rest
}) {
  const pad = {
    sm: '8px 16px',
    md: '12px 24px',
    lg: '15px 34px'
  }[size];
  const fontSize = {
    sm: '13px',
    md: '14px',
    lg: '15px'
  }[size];
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '9px',
    fontFamily: 'var(--font-ui)',
    fontWeight: 600,
    fontSize,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    lineHeight: 1,
    padding: pad,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid transparent',
    cursor: disabled ? 'not-allowed' : 'pointer',
    width: fullWidth ? '100%' : 'auto',
    opacity: disabled ? 0.5 : 1,
    transition: 'background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard), border-color var(--dur-fast) var(--ease-standard)',
    textDecoration: 'none',
    whiteSpace: 'nowrap'
  };
  const variants = {
    primary: {
      background: 'var(--bordeaux-700)',
      color: 'var(--parchment-50)',
      borderColor: 'var(--bordeaux-700)'
    },
    secondary: {
      background: 'transparent',
      color: 'var(--bordeaux-700)',
      borderColor: 'var(--bordeaux-700)'
    },
    brass: {
      background: 'var(--brass-500)',
      color: 'var(--ink-900)',
      borderColor: 'var(--brass-500)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-strong)',
      borderColor: 'transparent'
    },
    onDark: {
      background: 'var(--parchment-50)',
      color: 'var(--bordeaux-900)',
      borderColor: 'var(--parchment-50)'
    }
  };
  const hovers = {
    primary: {
      background: 'var(--bordeaux-800)',
      borderColor: 'var(--bordeaux-800)'
    },
    secondary: {
      background: 'var(--bordeaux-700)',
      color: 'var(--parchment-50)'
    },
    brass: {
      background: 'var(--brass-600)',
      borderColor: 'var(--brass-600)'
    },
    ghost: {
      background: 'var(--parchment-100)'
    },
    onDark: {
      background: 'var(--brass-300)',
      borderColor: 'var(--brass-300)'
    }
  };
  const [hover, setHover] = React.useState(false);
  const style = {
    ...base,
    ...variants[variant],
    ...(hover && !disabled ? hovers[variant] : {})
  };
  const Tag = as;
  return React.createElement(Tag, {
    style,
    disabled: as === 'button' ? disabled : undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    ...rest
  }, iconLeft, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/catalog/ProducerCard.jsx
try { (() => {
function ProducerCard({
  name,
  region,
  country,
  count,
  blurb,
  onClick
}) {
  const [hover, setHover] = React.useState(false);
  return React.createElement('article', {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-xs)',
      transition: 'box-shadow var(--dur-base) var(--ease-standard)',
      fontFamily: 'var(--font-ui)',
      height: '100%'
    }
  }, React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '12px'
    }
  }, React.createElement('h3', {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '24px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: 0,
      lineHeight: 1.1
    }
  }, name), count != null && React.createElement('span', {
    style: {
      fontSize: '12px',
      color: 'var(--text-muted)',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums'
    }
  }, count + (count === 1 ? ' wine' : ' wines'))), (region || country) && React.createElement('div', {
    style: {
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: 'var(--brass-700)'
    }
  }, [region, country].filter(Boolean).join(' · ')), blurb && React.createElement('p', {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '16px',
      lineHeight: 1.55,
      color: 'var(--text-body)',
      margin: '2px 0 6px',
      flex: 1
    }
  }, blurb), React.createElement('div', null, React.createElement(__ds_scope.Button, {
    variant: 'ghost',
    size: 'sm',
    onClick,
    style: {
      paddingLeft: 0
    }
  }, 'View Producer →')));
}
Object.assign(__ds_scope, { ProducerCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/catalog/ProducerCard.jsx", error: String((e && e.message) || e) }); }

// components/core/Eyebrow.jsx
try { (() => {
function Eyebrow({
  children,
  align = 'left',
  tone = 'brass',
  withRule = false
}) {
  const color = tone === 'bordeaux' ? 'var(--bordeaux-700)' : tone === 'vine' ? 'var(--vineyard-700)' : 'var(--brass-700)';
  return React.createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: align === 'center' ? 'center' : 'flex-start',
      gap: '12px',
      fontFamily: 'var(--font-ui)',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.22em',
      textTransform: 'uppercase',
      color
    }
  }, withRule && React.createElement('span', {
    style: {
      width: '28px',
      height: '1px',
      background: 'var(--brass-500)'
    }
  }), React.createElement('span', null, children));
}
Object.assign(__ds_scope, { Eyebrow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Eyebrow.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function Input({
  label,
  hint,
  error,
  icon = null,
  id,
  ...rest
}) {
  const inputId = id || (label ? 'fv-' + label.toLowerCase().replace(/\s+/g, '-') : undefined);
  const [focus, setFocus] = React.useState(false);
  const borderColor = error ? 'var(--danger)' : focus ? 'var(--brass-500)' : 'var(--border-default)';
  return React.createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      fontFamily: 'var(--font-ui)'
    }
  }, label && React.createElement('label', {
    htmlFor: inputId,
    style: {
      fontSize: '12px',
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: 'var(--text-strong)'
    }
  }, label), React.createElement('div', {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center'
    }
  }, icon && React.createElement('span', {
    style: {
      position: 'absolute',
      left: '12px',
      display: 'flex',
      color: 'var(--text-muted)'
    }
  }, icon), React.createElement('input', {
    id: inputId,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      width: '100%',
      fontFamily: 'var(--font-ui)',
      fontSize: '15px',
      color: 'var(--text-strong)',
      background: 'var(--white)',
      border: `1px solid ${borderColor}`,
      borderRadius: 'var(--radius-sm)',
      padding: icon ? '11px 14px 11px 38px' : '11px 14px',
      outline: 'none',
      transition: 'border-color var(--dur-fast) var(--ease-standard)',
      boxShadow: focus ? '0 0 0 3px rgba(194,161,78,0.18)' : 'none'
    },
    ...rest
  })), (hint || error) && React.createElement('span', {
    style: {
      fontSize: '12px',
      color: error ? 'var(--danger)' : 'var(--text-muted)'
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/Select.jsx
try { (() => {
function Select({
  label,
  hint,
  options = [],
  id,
  ...rest
}) {
  const selId = id || (label ? 'fv-sel-' + label.toLowerCase().replace(/\s+/g, '-') : undefined);
  const [focus, setFocus] = React.useState(false);
  return React.createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      fontFamily: 'var(--font-ui)'
    }
  }, label && React.createElement('label', {
    htmlFor: selId,
    style: {
      fontSize: '12px',
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: 'var(--text-strong)'
    }
  }, label), React.createElement('div', {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center'
    }
  }, React.createElement('select', {
    id: selId,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      width: '100%',
      appearance: 'none',
      WebkitAppearance: 'none',
      fontFamily: 'var(--font-ui)',
      fontSize: '15px',
      color: 'var(--text-strong)',
      background: 'var(--white)',
      border: `1px solid ${focus ? 'var(--brass-500)' : 'var(--border-default)'}`,
      borderRadius: 'var(--radius-sm)',
      padding: '11px 38px 11px 14px',
      outline: 'none',
      cursor: 'pointer',
      transition: 'border-color var(--dur-fast) var(--ease-standard)',
      boxShadow: focus ? '0 0 0 3px rgba(194,161,78,0.18)' : 'none'
    },
    ...rest
  }, options.map(o => {
    const value = typeof o === 'string' ? o : o.value;
    const text = typeof o === 'string' ? o : o.label;
    return React.createElement('option', {
      key: value,
      value
    }, text);
  })), React.createElement('span', {
    style: {
      position: 'absolute',
      right: '14px',
      pointerEvents: 'none',
      color: 'var(--text-muted)',
      fontSize: '11px'
    }
  }, '▾')), hint && React.createElement('span', {
    style: {
      fontSize: '12px',
      color: 'var(--text-muted)'
    }
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Select.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function Tag({
  children,
  tone = 'neutral',
  size = 'md',
  interactive = false,
  active = false,
  onClick,
  ...rest
}) {
  const tones = {
    neutral: {
      color: 'var(--ink-700)',
      border: 'var(--border-default)',
      bg: 'transparent'
    },
    bordeaux: {
      color: 'var(--bordeaux-700)',
      border: 'var(--bordeaux-300)',
      bg: 'transparent'
    },
    vine: {
      color: 'var(--vineyard-700)',
      border: 'var(--olive-300)',
      bg: 'transparent'
    },
    brass: {
      color: 'var(--brass-700)',
      border: 'var(--brass-300)',
      bg: 'var(--brass-100)'
    }
  };
  const t = tones[tone] || tones.neutral;
  const activeStyle = active ? {
    background: 'var(--bordeaux-700)',
    color: 'var(--parchment-50)',
    borderColor: 'var(--bordeaux-700)'
  } : {};
  const style = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: 'var(--font-ui)',
    fontSize: size === 'sm' ? '10.5px' : '11.5px',
    fontWeight: 600,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: t.color,
    background: t.bg,
    border: `1px solid ${t.border}`,
    borderRadius: 'var(--radius-sm)',
    padding: size === 'sm' ? '3px 8px' : '5px 11px',
    cursor: interactive ? 'pointer' : 'default',
    lineHeight: 1,
    transition: 'all var(--dur-fast) var(--ease-standard)',
    ...activeStyle
  };
  return React.createElement('span', {
    style,
    onClick,
    ...rest
  }, children);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/catalog/WineCard.jsx
try { (() => {
/* Bottle-label placeholder: a tall warm panel standing in for real bottle
   photography (Fine Vines supplies label shots per SKU). Pass `image` to use
   a real photo instead. */
function BottlePlaceholder({
  image,
  producer
}) {
  if (image) {
    return React.createElement('img', {
      src: image,
      alt: '',
      style: {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block'
      }
    });
  }
  const initials = (producer || 'FV').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return React.createElement('div', {
    style: {
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(170deg, var(--parchment-100), var(--parchment-200) 60%, var(--cork-300))',
      position: 'relative'
    }
  }, React.createElement('div', {
    style: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: '50%',
      transform: 'translateX(-50%)',
      width: '46px',
      background: 'rgba(107,22,48,0.06)',
      borderLeft: '1px solid var(--border-hairline)',
      borderRight: '1px solid var(--border-hairline)'
    }
  }), React.createElement('span', {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '34px',
      fontWeight: 600,
      color: 'var(--cork-600)',
      position: 'relative',
      letterSpacing: '0.04em'
    }
  }, initials));
}
function WineCard({
  producer,
  name,
  varietal,
  region,
  vintage,
  category,
  badge,
  image,
  onClick
}) {
  const [hover, setHover] = React.useState(false);
  return React.createElement('article', {
    onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      cursor: onClick ? 'pointer' : 'default',
      boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-xs)',
      transform: hover ? 'translateY(-3px)' : 'none',
      transition: 'box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-base) var(--ease-standard)',
      fontFamily: 'var(--font-ui)'
    }
  }, React.createElement('div', {
    style: {
      position: 'relative',
      aspectRatio: '3 / 4',
      background: 'var(--parchment-100)'
    }
  }, React.createElement(BottlePlaceholder, {
    image,
    producer
  }), badge && React.createElement('div', {
    style: {
      position: 'absolute',
      top: '10px',
      left: '10px'
    }
  }, React.createElement(__ds_scope.Badge, {
    tone: 'brass',
    solid: true
  }, badge))), React.createElement('div', {
    style: {
      padding: '16px 16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: '7px'
    }
  }, producer && React.createElement('div', {
    style: {
      fontSize: '10.5px',
      fontWeight: 600,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: 'var(--brass-700)'
    }
  }, producer), React.createElement('h3', {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '20px',
      fontWeight: 600,
      lineHeight: 1.15,
      color: 'var(--text-strong)',
      margin: 0
    }
  }, name, vintage && React.createElement('span', {
    style: {
      color: 'var(--text-muted)',
      fontWeight: 500
    }
  }, '  ' + vintage)), (varietal || region) && React.createElement('div', {
    style: {
      fontSize: '13px',
      color: 'var(--text-muted)',
      lineHeight: 1.4
    }
  }, [varietal, region].filter(Boolean).join(' · ')), category && React.createElement('div', {
    style: {
      marginTop: '4px'
    }
  }, React.createElement(__ds_scope.Tag, {
    tone: 'neutral',
    size: 'sm'
  }, category))));
}
Object.assign(__ds_scope, { WineCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/catalog/WineCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Footer.jsx
try { (() => {
/* Fine Vines site footer — trade notice, nav, contact, legal. */
function Footer({
  onNav
}) {
  const cols = [['Explore', [['portfolio', 'Portfolio'], ['about', 'About Us'], ['news', 'News & Events'], ['contact', 'Contact']]], ['For the Trade', [['contact', 'Become a Customer'], ['contact', 'Credit Application'], ['contact', 'Illinois Liquor License']]]];
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      background: 'var(--bordeaux-900)',
      color: 'var(--text-on-dark)',
      fontFamily: 'var(--font-ui)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '64px var(--gutter) 40px',
      display: 'grid',
      gridTemplateColumns: '1.4fr 1fr 1fr 1.2fr',
      gap: '40px'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("img", {
    src: window.FV_LOGO || "../../assets/logo/finevines-logo.png",
    alt: "Fine Vines",
    style: {
      height: '26px',
      filter: 'brightness(0) invert(1) opacity(0.92)'
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '16px',
      lineHeight: 1.6,
      color: 'var(--text-on-dark-muted)',
      marginTop: '18px',
      maxWidth: '320px'
    }
  }, "A licensed Illinois wholesale distributor of fine wine. By law, we sell only to licensed retailers and restaurants within the State of Illinois.")), cols.map(([title, links]) => /*#__PURE__*/React.createElement("div", {
    key: title
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: 'var(--brass-300)',
      marginBottom: '16px'
    }
  }, title), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '11px'
    }
  }, links.map(([id, label], i) => /*#__PURE__*/React.createElement("li", {
    key: i
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav(id);
    },
    style: {
      color: 'var(--text-on-dark-muted)',
      textDecoration: 'none',
      fontSize: '14px'
    }
  }, label)))))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: 'var(--brass-300)',
      marginBottom: '16px'
    }
  }, "Contact"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: '14px',
      lineHeight: 1.7,
      color: 'var(--text-on-dark-muted)',
      margin: 0
    }
  }, "2725 Thomas St", /*#__PURE__*/React.createElement("br", null), "Melrose Park, IL 60160", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("a", {
    href: "tel:7083436702",
    style: {
      color: 'var(--brass-300)',
      textDecoration: 'none'
    }
  }, "(708) 343-6702"), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("a", {
    href: "mailto:info@finevines.com",
    style: {
      color: 'var(--brass-300)',
      textDecoration: 'none'
    }
  }, "info@finevines.com")))), /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: '1px solid var(--border-on-dark)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '18px var(--gutter)',
      display: 'flex',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: '12px',
      fontSize: '12px',
      color: 'var(--text-on-dark-muted)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "\xA9 ", new Date().getFullYear(), " Fine Vines, Inc. All rights reserved."), /*#__PURE__*/React.createElement("span", {
    style: {
      letterSpacing: '0.1em'
    }
  }, "SERVICE \xB7 QUALITY \xB7 EXPERTISE \xA0\xB7\xA0 Please drink responsibly."))));
}
window.Footer = Footer;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Footer.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Header.jsx
try { (() => {
/* Fine Vines site header — logo, primary nav, trade CTA. */
function Header({
  active,
  onNav
}) {
  const {
    Button
  } = window.FineVinesDesignSystem_d87fe4;
  const nav = [['home', 'Home'], ['portfolio', 'Portfolio'], ['news', 'News & Events'], ['about', 'About Us'], ['contact', 'Contact']];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 50,
      background: 'rgba(250,246,238,0.92)',
      backdropFilter: 'blur(8px)',
      borderBottom: '1px solid var(--border-hairline)',
      fontFamily: 'var(--font-ui)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--gutter)',
      height: 'var(--header-height)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '32px'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('home');
    },
    style: {
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: window.FV_LOGO || "../../assets/logo/finevines-logo.png",
    alt: "Fine Vines",
    style: {
      height: '30px',
      width: 'auto',
      display: 'block'
    }
  })), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '30px'
    }
  }, nav.map(([id, label]) => /*#__PURE__*/React.createElement("a", {
    key: id,
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav(id);
    },
    style: {
      fontSize: '13px',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: active === id ? 'var(--bordeaux-700)' : 'var(--text-muted)',
      fontWeight: active === id ? 700 : 600,
      textDecoration: 'none',
      paddingBottom: '4px',
      borderBottom: active === id ? '2px solid var(--brass-500)' : '2px solid transparent',
      transition: 'color var(--dur-fast), border-color var(--dur-fast)'
    }
  }, label))), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    onClick: () => onNav('contact')
  }, "Become a Customer")));
}
window.Header = Header;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/HomeScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Home screen. */
function HomeScreen({
  onNav,
  onOpenWine,
  onOpenProducer
}) {
  const {
    Button,
    Eyebrow,
    WineCard,
    ProducerCard
  } = window.FineVinesDesignSystem_d87fe4;
  const {
    VineyardBg,
    Section
  } = window;
  const data = window.FV_DATA;
  const pillars = [['Service', 'At day\u2019s end, we\u2019re a service company. Our drivers, warehouse, and support staff exist to give you the best possible service.'], ['Quality', 'Every wine is kept under temperature and humidity control from the winery to your door \u2014 handled like fresh produce.'], ['Expertise', 'Our sales team carries a combined 200+ years in the wholesale, retail, and restaurant trade. Training your staff is part of the service.']];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(VineyardBg, {
    height: "640px"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--gutter)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: '720px'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true,
    tone: "brass",
    style: {
      color: 'var(--brass-300)'
    }
  }, "Service \xB7 Quality \xB7 Expertise"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '68px',
      fontWeight: 600,
      lineHeight: 1.02,
      color: 'var(--parchment-50)',
      margin: '18px 0 0',
      letterSpacing: '-0.01em'
    }
  }, "Fine wine, handled", /*#__PURE__*/React.createElement("br", null), "like fresh produce."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '21px',
      lineHeight: 1.5,
      color: 'var(--text-on-dark-muted)',
      maxWidth: '560px',
      margin: '24px 0 34px'
    }
  }, "We represent some of the world's top producers and importers, delivered cold-chain to licensed retailers and restaurants across Illinois."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '14px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "onDark",
    size: "lg",
    onClick: () => onNav('portfolio')
  }, "View Our Portfolio"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "lg",
    onClick: () => onNav('contact'),
    style: {
      color: 'var(--parchment-50)',
      borderColor: 'var(--parchment-50)'
    }
  }, "Become a Customer"))))), /*#__PURE__*/React.createElement(Section, {
    pad: "84px 0 76px"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: '48px'
    }
  }, pillars.map(([title, body]) => /*#__PURE__*/React.createElement("div", {
    key: title
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '40px',
      height: '2px',
      background: 'var(--brass-500)',
      marginBottom: '20px'
    }
  }), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '30px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: '0 0 12px'
    }
  }, title), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '17px',
      lineHeight: 1.6,
      color: 'var(--text-body)',
      margin: 0
    }
  }, body))))), /*#__PURE__*/React.createElement(Section, {
    bg: "var(--bg-sunken)",
    pad: "80px 0"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      marginBottom: '36px',
      gap: '24px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "The Portfolio"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '42px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: '12px 0 0'
    }
  }, "The heart of what we do")), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    onClick: () => onNav('portfolio')
  }, "Browse All Wines")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: '24px'
    }
  }, data.wines.slice(0, 4).map(w => /*#__PURE__*/React.createElement(WineCard, _extends({
    key: w.id
  }, w, {
    onClick: () => onOpenWine(w.id)
  }))))), /*#__PURE__*/React.createElement(Section, {
    pad: "84px 0"
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "Featured Producers"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '42px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: '12px 0 36px'
    }
  }, "Families behind the bottles"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: '24px'
    }
  }, data.producers.slice(0, 3).map(p => /*#__PURE__*/React.createElement(ProducerCard, _extends({
    key: p.id
  }, p, {
    onClick: () => onOpenProducer(p.id)
  }))))), /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--bordeaux-900)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-narrow)',
      margin: '0 auto',
      padding: '76px var(--gutter)',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    align: "center",
    style: {
      color: 'var(--brass-300)'
    }
  }, "For the Trade"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '44px',
      fontWeight: 600,
      color: 'var(--parchment-50)',
      margin: '14px 0 16px'
    }
  }, "Become a Fine Vines customer"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '19px',
      lineHeight: 1.6,
      color: 'var(--text-on-dark-muted)',
      margin: '0 auto 30px',
      maxWidth: '520px'
    }
  }, "Download our credit application, then send it along with a copy of your Illinois Liquor License and we'll get back to you promptly."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '14px',
      justifyContent: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "onDark",
    size: "lg",
    onClick: () => onNav('contact')
  }, "Credit Application"), /*#__PURE__*/React.createElement(Button, {
    variant: "brass",
    size: "lg",
    onClick: () => onNav('contact')
  }, "Contact Sales")))));
}
window.HomeScreen = HomeScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/HomeScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/MiscScreens.jsx
try { (() => {
/* About, News & Events, and Contact screens. */

function AboutScreen({
  onNav
}) {
  const {
    Eyebrow,
    Button
  } = window.FineVinesDesignSystem_d87fe4;
  const {
    VineyardBg
  } = window;
  const team = [['George Molitor', 'Founder & President'], ['Connie Molitor', 'Operations'], ['Kevin Cahoon', 'Sales'], ['Vincent Ehret', 'Sales'], ['Todd Huddleston', 'Sales'], ['John Vitale', 'Sales']];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(VineyardBg, {
    height: "380px"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-narrow)',
      margin: '0 auto',
      padding: '0 var(--gutter)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true,
    style: {
      color: 'var(--brass-300)'
    }
  }, "About Us"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '56px',
      fontWeight: 600,
      color: 'var(--parchment-50)',
      margin: '16px 0 0',
      lineHeight: 1.05
    }
  }, "A service company,", /*#__PURE__*/React.createElement("br", null), "first and last."))), /*#__PURE__*/React.createElement("section", {
    style: {
      padding: '76px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-narrow)',
      margin: '0 auto',
      padding: '0 var(--gutter)'
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '22px',
      lineHeight: 1.55,
      color: 'var(--text-strong)',
      marginTop: 0
    }
  }, "Fine Vines is a licensed wholesale distributor of fine wine. By law, we can only sell to licensed retailers and restaurants within the State of Illinois."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '18px',
      lineHeight: 1.7,
      color: 'var(--text-body)'
    }
  }, "The Fine Vines team is made up of our sales force, our drivers, and our warehouse and support personnel. Everyone is focused on delivering the best possible service to our customers and our suppliers. To do that, we ensure that all our products are handled under the proper temperature and humidity \u2014 we carefully pick each order and load our delivery vehicles in a temperature-controlled warehouse."), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '18px',
      lineHeight: 1.7,
      color: 'var(--text-body)'
    }
  }, "Our sales team has a combined experience of over 200 years in the wholesale wine, retail and restaurant industries. Training your staff is part of the service \u2014 if you need information, technical specs, or an in-person training session, just ask."))), /*#__PURE__*/React.createElement("section", {
    style: {
      background: 'var(--bg-sunken)',
      padding: '72px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--gutter)'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "The Team"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: '20px',
      marginTop: '28px'
    }
  }, team.map(([name, role]) => /*#__PURE__*/React.createElement("div", {
    key: name,
    style: {
      background: 'var(--surface-card)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      padding: '22px',
      display: 'flex',
      alignItems: 'center',
      gap: '16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '52px',
      height: '52px',
      borderRadius: '50%',
      background: 'var(--bordeaux-700)',
      color: 'var(--parchment-50)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'var(--font-display)',
      fontSize: '22px',
      fontWeight: 600,
      flex: 'none'
    }
  }, name.split(' ').map(n => n[0]).join('')), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '21px',
      fontWeight: 600,
      color: 'var(--text-strong)'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: 'var(--brass-700)'
    }
  }, role))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: '40px'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    onClick: () => onNav('contact')
  }, "Become a Customer")))));
}
window.AboutScreen = AboutScreen;
function NewsScreen() {
  const {
    Eyebrow,
    Tag
  } = window.FineVinesDesignSystem_d87fe4;
  const items = [['Trade Tasting', 'Spring Portfolio Tasting — Chicago', 'April 18', 'Join our team and visiting winemakers for a walk-through of new-vintage Burgundy, Wachau, and Piedmont arrivals at the Old Post Office.'], ['New Arrival', 'Hubert Lamy 2021s have landed', 'March 30', 'The full range of Saint-Aubin 1er Crus is now in our temperature-controlled warehouse and available to order.'], ['Producer Visit', 'FX Pichler joins us in Illinois', 'March 12', 'Lucas Pichler will host trade-only sessions for restaurant and retail partners across the Chicago market.'], ['Press', 'Three Wine Company old-vine Zin reviewed', 'February 24', 'Matt Cline\u2019s head-trained Contra Costa Zinfandel earns strong marks for purity and balance.']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-narrow)',
      margin: '0 auto',
      padding: '60px var(--gutter) 96px'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "News & Events"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '52px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: '14px 0 40px'
    }
  }, "From the warehouse floor"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column'
    }
  }, items.map(([tag, title, date, body], i) => /*#__PURE__*/React.createElement("article", {
    key: i,
    style: {
      display: 'grid',
      gridTemplateColumns: '110px 1fr',
      gap: '28px',
      padding: '28px 0',
      borderTop: '1px solid var(--border-hairline)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '13px',
      color: 'var(--text-muted)',
      paddingTop: '4px'
    }
  }, date), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: '10px'
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    tone: "bordeaux",
    size: "sm"
  }, tag)), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '28px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: '0 0 8px'
    }
  }, title), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '17px',
      lineHeight: 1.6,
      color: 'var(--text-body)',
      margin: 0
    }
  }, body))))));
}
window.NewsScreen = NewsScreen;
function ContactScreen() {
  const {
    Eyebrow,
    Input,
    Select,
    Button
  } = window.FineVinesDesignSystem_d87fe4;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '60px var(--gutter) 96px',
      display: 'grid',
      gridTemplateColumns: '1fr 380px',
      gap: '72px',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "Become a Customer"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '48px',
      fontWeight: 600,
      color: 'var(--text-strong)',
      margin: '14px 0 10px'
    }
  }, "Open a trade account"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '18px',
      lineHeight: 1.6,
      color: 'var(--text-body)',
      maxWidth: '520px',
      marginBottom: '34px'
    }
  }, "Tell us about your business. Submit this along with your Illinois Liquor License and a completed credit application, and a member of our sales team will be in touch promptly."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '18px',
      maxWidth: '560px'
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "Business name",
    placeholder: "e.g. The Corner Cellar"
  }), /*#__PURE__*/React.createElement(Select, {
    label: "Account type",
    options: ['Restaurant', 'Retailer', 'Hotel / Hospitality', 'Other']
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Contact name",
    placeholder: "First & last"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Illinois Liquor License #",
    placeholder: "1A-1234567"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Email",
    type: "email",
    placeholder: "buyer@business.com"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Phone",
    type: "tel",
    placeholder: "(312) 555-0142"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '14px',
      marginTop: '28px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg"
  }, "Submit Application"), /*#__PURE__*/React.createElement(Button, {
    variant: "brass",
    size: "lg"
  }, "Download Credit Application (PDF)"))), /*#__PURE__*/React.createElement("aside", {
    style: {
      background: 'var(--bordeaux-900)',
      borderRadius: 'var(--radius-md)',
      padding: '32px',
      color: 'var(--text-on-dark)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--brass-300)',
      marginBottom: '18px'
    }
  }, "Get in touch"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '17px',
      lineHeight: 1.8,
      color: 'var(--text-on-dark-muted)',
      margin: 0
    }
  }, "Fine Vines, Inc.", /*#__PURE__*/React.createElement("br", null), "2725 Thomas St", /*#__PURE__*/React.createElement("br", null), "Melrose Park, IL 60160"), /*#__PURE__*/React.createElement("hr", {
    style: {
      border: 'none',
      borderTop: '1px solid var(--border-on-dark)',
      margin: '22px 0'
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '17px',
      lineHeight: 1.9,
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "tel:7083436702",
    style: {
      color: 'var(--brass-300)',
      textDecoration: 'none'
    }
  }, "(708) 343-6702"), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("a", {
    href: "mailto:info@finevines.com",
    style: {
      color: 'var(--brass-300)',
      textDecoration: 'none'
    }
  }, "info@finevines.com")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
      lineHeight: 1.6,
      color: 'var(--text-on-dark-muted)',
      marginTop: '22px'
    }
  }, "Licensed Illinois retailers & restaurants only. Please drink responsibly.")));
}
window.ContactScreen = ContactScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/MiscScreens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Parts.jsx
try { (() => {
/* Shared visual parts for the Fine Vines UI kit. */

/* Warm "vineyard at sunset" background stand-in. Layered warm gradients +
   film grain. NOTE: replace with real vineyard photography in production
   (e.g. background-image of the supplied hero shot). */
function VineyardBg({
  children,
  height = '620px',
  overlay = true
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height,
      overflow: 'hidden',
      background: 'linear-gradient(170deg, #2a0a13 0%, #6b1630 32%, #9a3b2f 56%, #c2772f 78%, #ddb15a 100%)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      right: '14%',
      bottom: '8%',
      width: '420px',
      height: '420px',
      borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(255,225,170,0.55), rgba(255,200,120,0) 62%)',
      filter: 'blur(6px)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: '34%',
      background: 'linear-gradient(0deg, rgba(28,12,10,0.85), rgba(46,30,22,0) 100%)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      opacity: 0.10,
      mixBlendMode: 'overlay',
      backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'2\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")'
    }
  }), overlay && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'var(--img-warm-overlay)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      height: '100%'
    }
  }, children));
}
window.VineyardBg = VineyardBg;

/* Section wrapper with max-width container. */
function Section({
  children,
  bg = 'transparent',
  pad = '88px 0'
}) {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: bg,
      padding: pad
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--gutter)'
    }
  }, children));
}
window.Section = Section;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Parts.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/PortfolioScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Portfolio screen — faceted catalog. */
function PortfolioScreen({
  onOpenWine
}) {
  const {
    Eyebrow,
    Tag,
    Select,
    Input,
    FacetGroup,
    WineCard
  } = window.FineVinesDesignSystem_d87fe4;
  const data = window.FV_DATA;
  const [selected, setSelected] = React.useState([]);
  const [query, setQuery] = React.useState('');
  const toggle = l => setSelected(s => s.includes(l) ? s.filter(x => x !== l) : [...s, l]);
  const wines = data.wines.filter(w => {
    const q = query.trim().toLowerCase();
    if (q && !`${w.producer} ${w.name} ${w.varietal} ${w.region}`.toLowerCase().includes(q)) return false;
    if (selected.length === 0) return true;
    const vals = [w.varietal, w.region, w.producer, w.closure, w.size, w.category].filter(Boolean);
    return selected.some(s => vals.includes(s));
  });
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bordeaux-900)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '54px var(--gutter) 50px'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    style: {
      color: 'var(--brass-300)'
    }
  }, "The Portfolio"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '52px',
      fontWeight: 600,
      color: 'var(--parchment-50)',
      margin: '12px 0 8px'
    }
  }, "Browse the catalog"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '18px',
      color: 'var(--text-on-dark-muted)',
      margin: 0,
      maxWidth: '560px'
    }
  }, "Filter 200+ wines by producer, varietal, region, closure, bottle size, category, style, and vintage."))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '36px var(--gutter) 88px',
      display: 'grid',
      gridTemplateColumns: '264px 1fr',
      gap: '44px',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("aside", {
    style: {
      position: 'sticky',
      top: 'calc(var(--header-height) + 20px)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: '8px'
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "",
    icon: /*#__PURE__*/React.createElement("span", {
      "aria-hidden": "true"
    }, "\u2315"),
    placeholder: "Search producer, wine\u2026",
    value: query,
    onChange: e => setQuery(e.target.value)
  })), Object.entries(data.facets).map(([title, options], i) => /*#__PURE__*/React.createElement(FacetGroup, {
    key: title,
    title: title,
    options: options,
    selected: selected,
    onToggle: toggle,
    defaultOpen: i < 3
  }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '20px',
      marginBottom: '20px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '14px',
      color: 'var(--text-muted)'
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      color: 'var(--text-strong)'
    }
  }, wines.length), " wines"), /*#__PURE__*/React.createElement("div", {
    style: {
      width: '230px'
    }
  }, /*#__PURE__*/React.createElement(Select, {
    options: ['Sort: Producer A–Z', 'Vintage (newest)', 'Region', 'Recently added']
  }))), selected.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      marginBottom: '22px'
    }
  }, selected.map(s => /*#__PURE__*/React.createElement(Tag, {
    key: s,
    tone: "bordeaux",
    active: true,
    interactive: true,
    onClick: () => toggle(s)
  }, s, " \u2715")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setSelected([]),
    style: {
      all: 'unset',
      cursor: 'pointer',
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
      color: 'var(--text-muted)',
      textDecoration: 'underline',
      alignSelf: 'center'
    }
  }, "Clear all")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: '24px'
    }
  }, wines.map(w => /*#__PURE__*/React.createElement(WineCard, _extends({
    key: w.id
  }, w, {
    onClick: () => onOpenWine(w.id)
  })))), wines.length === 0 && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '18px',
      color: 'var(--text-muted)',
      padding: '40px 0'
    }
  }, "No wines match those filters."))));
}
window.PortfolioScreen = PortfolioScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/PortfolioScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/ProducerScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Producer detail screen. */
function ProducerScreen({
  producerId,
  onNav,
  onOpenWine
}) {
  const {
    Eyebrow,
    Button,
    WineCard
  } = window.FineVinesDesignSystem_d87fe4;
  const {
    VineyardBg
  } = window;
  const data = window.FV_DATA;
  const p = data.producers.find(x => x.id === producerId) || data.producers[0];
  const wines = data.wines.filter(w => w.producerId === p.id);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(VineyardBg, {
    height: "340px",
    overlay: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--gutter)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      paddingBottom: '40px'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onNav('portfolio'),
    style: {
      all: 'unset',
      cursor: 'pointer',
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: 'var(--brass-300)',
      marginBottom: '14px'
    }
  }, "\u2190 All Producers"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '12px',
      fontWeight: 600,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: 'var(--brass-300)'
    }
  }, p.region, " \xB7 ", p.country), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '60px',
      fontWeight: 600,
      color: 'var(--parchment-50)',
      margin: '8px 0 0',
      lineHeight: 1
    }
  }, p.name))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '64px var(--gutter) 88px',
      display: 'grid',
      gridTemplateColumns: '1fr 320px',
      gap: '64px',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "The Story"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '22px',
      lineHeight: 1.55,
      color: 'var(--text-strong)',
      margin: '18px 0 18px',
      maxWidth: '620px'
    }
  }, p.blurb), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '17px',
      lineHeight: 1.7,
      color: 'var(--text-body)',
      maxWidth: '620px'
    }
  }, "We have the privilege to represent producers who share our values: an unwavering commitment to terroir, craft, and the best possible quality-to-price ratio in the market. Every wine in this portfolio is handled under temperature and humidity control from the winery to your door.")), /*#__PURE__*/React.createElement("aside", {
    style: {
      background: 'var(--surface-card-alt)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      padding: '24px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '11px',
      fontWeight: 700,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--brass-700)',
      marginBottom: '14px'
    }
  }, "At a Glance"), /*#__PURE__*/React.createElement("dl", {
    style: {
      margin: 0,
      fontFamily: 'var(--font-ui)',
      fontSize: '14px'
    }
  }, [['Region', p.region], ['Country', p.country], ['Wines', wines.length + ' in portfolio']].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: '9px 0',
      borderBottom: '1px solid var(--border-hairline)'
    }
  }, /*#__PURE__*/React.createElement("dt", {
    style: {
      color: 'var(--text-muted)'
    }
  }, k), /*#__PURE__*/React.createElement("dd", {
    style: {
      margin: 0,
      fontWeight: 500,
      color: 'var(--text-strong)'
    }
  }, v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: '18px'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "sm",
    fullWidth: true,
    onClick: () => onNav('contact')
  }, "Request Samples")))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '0 var(--gutter) 96px'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "Wines from ", p.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: '24px',
      marginTop: '28px'
    }
  }, wines.map(w => /*#__PURE__*/React.createElement(WineCard, _extends({
    key: w.id
  }, w, {
    onClick: () => onOpenWine(w.id)
  }))))));
}
window.ProducerScreen = ProducerScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/ProducerScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/ProductScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Product (wine) detail screen. */
function ProductScreen({
  wineId,
  onNav,
  onOpenWine,
  onOpenProducer
}) {
  const {
    Eyebrow,
    Tag,
    Badge,
    Button,
    SpecTable,
    WineCard
  } = window.FineVinesDesignSystem_d87fe4;
  const data = window.FV_DATA;
  const w = data.wines.find(x => x.id === wineId) || data.wines[0];
  const initials = w.producer.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  const more = data.wines.filter(x => x.producerId === w.producerId && x.id !== w.id).slice(0, 3);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: '28px var(--gutter) 88px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '13px',
      color: 'var(--text-muted)',
      marginBottom: '28px',
      display: 'flex',
      gap: '8px'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNav('portfolio');
    },
    style: {
      color: 'var(--text-link)',
      textDecoration: 'none'
    }
  }, "Portfolio"), /*#__PURE__*/React.createElement("span", null, "/"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onOpenProducer(w.producerId);
    },
    style: {
      color: 'var(--text-link)',
      textDecoration: 'none'
    }
  }, w.producer), /*#__PURE__*/React.createElement("span", null, "/"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, w.name)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1.15fr',
      gap: '64px',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'sticky',
      top: 'calc(var(--header-height) + 20px)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: '3 / 4',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-hairline)',
      background: 'linear-gradient(170deg, var(--parchment-100), var(--parchment-200) 60%, var(--cork-300))',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      boxShadow: 'var(--shadow-sm)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: '50%',
      transform: 'translateX(-50%)',
      width: '120px',
      background: 'rgba(107,22,48,0.06)',
      borderLeft: '1px solid var(--border-hairline)',
      borderRight: '1px solid var(--border-hairline)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '64px',
      fontWeight: 600,
      color: 'var(--cork-600)',
      position: 'relative'
    }
  }, initials))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      marginBottom: '14px'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    tone: "brass",
    style: {
      marginBottom: 0
    }
  }, w.producer), w.badge && /*#__PURE__*/React.createElement(Badge, {
    tone: "brass",
    solid: true
  }, w.badge)), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '46px',
      fontWeight: 600,
      lineHeight: 1.08,
      color: 'var(--text-strong)',
      margin: '0 0 6px'
    }
  }, w.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-display)',
      fontSize: '26px',
      color: 'var(--text-muted)',
      marginBottom: '18px'
    }
  }, w.vintage), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap',
      marginBottom: '26px'
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    tone: "bordeaux"
  }, w.varietal), /*#__PURE__*/React.createElement(Tag, {
    tone: "vine"
  }, w.region), /*#__PURE__*/React.createElement(Tag, {
    tone: "neutral"
  }, w.category)), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-body)',
      fontSize: '18px',
      lineHeight: 1.65,
      color: 'var(--text-body)',
      maxWidth: '540px'
    }
  }, "A benchmark expression of ", w.varietal, " from ", w.region, ", kept under strict temperature and humidity control from the winery to your door. Pure fruit, fine-grained structure, and a long, savory finish."), /*#__PURE__*/React.createElement("hr", {
    className: "fv-rule",
    style: {
      margin: '30px 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: '460px'
    }
  }, /*#__PURE__*/React.createElement(SpecTable, {
    title: "Technical Specs",
    rows: [['Producer', w.producer], ['Varietal', w.varietal], ['Region', w.region], ['Vintage', String(w.vintage)], ['Style', w.style], ['Closure', w.closure], ['Bottle size', w.size], ['Case pack', '12 × ' + w.size]]
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '14px',
      marginTop: '32px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    onClick: () => onNav('contact')
  }, "Add to Order Inquiry"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "lg",
    onClick: () => onOpenProducer(w.producerId)
  }, "About the Producer")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: '12.5px',
      color: 'var(--text-faint)',
      marginTop: '16px'
    }
  }, "Available to licensed Illinois retailers & restaurants only. Pricing shown in your trade account."))), more.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: '80px'
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    withRule: true
  }, "More from ", w.producer), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)',
      gap: '24px',
      marginTop: '28px'
    }
  }, more.map(m => /*#__PURE__*/React.createElement(WineCard, _extends({
    key: m.id
  }, m, {
    onClick: () => onOpenWine(m.id)
  }))))));
}
window.ProductScreen = ProductScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/ProductScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/data.js
try { (() => {
window.FV_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA7AAAACpCAYAAAASjNEMAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyRpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuMy1jMDExIDY2LjE0NTY2MSwgMjAxMi8wMi8wNi0xNDo1NjoyNyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENTNiAoTWFjaW50b3NoKSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo1MjY1ODIwN0VEOEIxMUU2ODRFQ0YxRDM5Mzc4QzM3NiIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDo1MjY1ODIwOEVEOEIxMUU2ODRFQ0YxRDM5Mzc4QzM3NiI+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOjUyNjU4MjA1RUQ4QjExRTY4NEVDRjFEMzkzNzhDMzc2IiBzdFJlZjpkb2N1bWVudElEPSJ4bXAuZGlkOjUyNjU4MjA2RUQ4QjExRTY4NEVDRjFEMzkzNzhDMzc2Ii8+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+VWuLpAAAQZdJREFUeNrs3Qlg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";
/* Sample catalog data for the Fine Vines website UI kit. Producers and wines
   drawn from the real Fine Vines portfolio (finevines.com). Stand-in copy. */
window.FV_DATA = function () {
  const producers = [{
    id: 'hubert-lamy',
    name: 'Hubert Lamy',
    region: 'Saint-Aubin',
    country: 'France',
    blurb: 'Olivier Lamy farms 17 hectares across Saint-Aubin, Puligny- and Chassagne-Montrachet, working high-density plantings and a deft, low-intervention hand in the cellar.'
  }, {
    id: 'fx-pichler',
    name: 'FX Pichler',
    region: 'Wachau',
    country: 'Austria',
    blurb: 'A reference estate of the Wachau, crafting precise, age-worthy Grüner Veltliner and Riesling from the region\u2019s steep, terraced vineyards.'
  }, {
    id: 'giacomo-brezza',
    name: 'Giacomo Brezza',
    region: 'Barolo',
    country: 'Italy',
    blurb: 'Five generations in Barolo, with holdings in Cannubi and Sarmassa producing classically structured, traditional Nebbiolo.'
  }, {
    id: 'famille-bourgeois',
    name: 'Famille Bourgeois',
    region: 'Sancerre',
    country: 'France',
    blurb: 'Tenth-generation vignerons in Chavignol, mapping Sancerre\u2019s terres blanches, caillottes and silex into vivid, mineral Sauvignon Blanc.'
  }, {
    id: 'three-wine-company',
    name: 'Three Wine Company',
    region: 'Contra Costa',
    country: 'USA',
    blurb: 'Matt Cline champions old-vine, head-trained Zinfandel and Carignane from California\u2019s historic sandy-soil vineyards.'
  }, {
    id: 'stoller',
    name: 'Stoller Family Estate',
    region: 'Dundee Hills',
    country: 'USA',
    blurb: 'The largest contiguous estate in the Dundee Hills, farming sustainably for bright, red-fruited Willamette Valley Pinot Noir.'
  }];
  const wines = [{
    id: 1,
    producer: 'Hubert Lamy',
    producerId: 'hubert-lamy',
    name: 'Saint-Aubin 1er Cru « Derrière chez Édouard »',
    varietal: 'Chardonnay',
    region: 'Burgundy',
    vintage: 2021,
    category: 'White · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Dry',
    badge: 'New Arrival'
  }, {
    id: 2,
    producer: 'FX Pichler',
    producerId: 'fx-pichler',
    name: 'Grüner Veltliner Smaragd « Kellerberg »',
    varietal: 'Grüner Veltliner',
    region: 'Wachau',
    vintage: 2020,
    category: 'White · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Dry'
  }, {
    id: 3,
    producer: 'Giacomo Brezza',
    producerId: 'giacomo-brezza',
    name: 'Barolo « Cannubi »',
    varietal: 'Nebbiolo',
    region: 'Piedmont',
    vintage: 2018,
    category: 'Red · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Dry',
    badge: 'Allocated'
  }, {
    id: 4,
    producer: 'Famille Bourgeois',
    producerId: 'famille-bourgeois',
    name: 'Sancerre « Les Monts Damnés »',
    varietal: 'Sauvignon Blanc',
    region: 'Loire',
    vintage: 2022,
    category: 'White · Still',
    closure: 'Screwcap',
    size: '750ml',
    style: 'Dry'
  }, {
    id: 5,
    producer: 'Three Wine Company',
    producerId: 'three-wine-company',
    name: 'Old Vine Zinfandel',
    varietal: 'Zinfandel',
    region: 'Contra Costa',
    vintage: 2021,
    category: 'Red · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Dry'
  }, {
    id: 6,
    producer: 'Stoller Family Estate',
    producerId: 'stoller',
    name: 'Dundee Hills Pinot Noir',
    varietal: 'Pinot Noir',
    region: 'Willamette Valley',
    vintage: 2021,
    category: 'Red · Still',
    closure: 'Screwcap',
    size: '750ml',
    style: 'Dry',
    badge: 'New Arrival'
  }, {
    id: 7,
    producer: 'Hubert Lamy',
    producerId: 'hubert-lamy',
    name: 'Bourgogne Blanc « Les Chataigniers »',
    varietal: 'Chardonnay',
    region: 'Burgundy',
    vintage: 2022,
    category: 'White · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Dry'
  }, {
    id: 8,
    producer: 'Giacomo Brezza',
    producerId: 'giacomo-brezza',
    name: 'Barbera d\u2019Alba',
    varietal: 'Barbera',
    region: 'Piedmont',
    vintage: 2021,
    category: 'Red · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Dry'
  }, {
    id: 9,
    producer: 'FX Pichler',
    producerId: 'fx-pichler',
    name: 'Riesling Federspiel « Loibner »',
    varietal: 'Riesling',
    region: 'Wachau',
    vintage: 2021,
    category: 'White · Still',
    closure: 'Cork',
    size: '750ml',
    style: 'Off-dry'
  }];
  const facets = {
    Producer: [{
      label: 'Hubert Lamy',
      count: 14
    }, {
      label: 'FX Pichler',
      count: 9
    }, {
      label: 'Giacomo Brezza',
      count: 11
    }, {
      label: 'Famille Bourgeois',
      count: 9
    }],
    Varietal: [{
      label: 'Chardonnay',
      count: 42
    }, {
      label: 'Pinot Noir',
      count: 38
    }, {
      label: 'Nebbiolo',
      count: 16
    }, {
      label: 'Riesling',
      count: 21
    }, {
      label: 'Sauvignon Blanc',
      count: 12
    }],
    Region: [{
      label: 'Burgundy',
      count: 54
    }, {
      label: 'Wachau',
      count: 18
    }, {
      label: 'Piedmont',
      count: 22
    }, {
      label: 'Loire',
      count: 15
    }, {
      label: 'Willamette Valley',
      count: 11
    }],
    Closure: [{
      label: 'Cork',
      count: 188
    }, {
      label: 'Screwcap',
      count: 24
    }],
    'Bottle Size': [{
      label: '750ml',
      count: 196
    }, {
      label: '1.5L Magnum',
      count: 18
    }, {
      label: '375ml',
      count: 9
    }],
    Category: [{
      label: 'Red · Still',
      count: 96
    }, {
      label: 'White · Still',
      count: 102
    }, {
      label: 'Sparkling',
      count: 12
    }, {
      label: 'Dessert',
      count: 6
    }],
    Vintage: [{
      label: '2022',
      count: 44
    }, {
      label: '2021',
      count: 61
    }, {
      label: '2020',
      count: 38
    }, {
      label: '2019',
      count: 22
    }]
  };
  return {
    producers,
    wines,
    facets
  };
}();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/data.js", error: String((e && e.message) || e) }); }

__ds_ns.FacetGroup = __ds_scope.FacetGroup;

__ds_ns.ProducerCard = __ds_scope.ProducerCard;

__ds_ns.SpecTable = __ds_scope.SpecTable;

__ds_ns.WineCard = __ds_scope.WineCard;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Eyebrow = __ds_scope.Eyebrow;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Tag = __ds_scope.Tag;

})();
