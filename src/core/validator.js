// Port of App\Core\Validator: rules 'a|b:p', first failing rule per field wins.
function label(field) {
  const s = field.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0);
}

function validate(data, rules) {
  const errors = {};
  for (const [field, ruleStr] of Object.entries(rules)) {
    const value = data[field] !== undefined ? data[field] : null;
    const lbl = label(field);
    const parts = Array.isArray(ruleStr) ? ruleStr : String(ruleStr).split('|');
    for (const part of parts) {
      const [rule, paramStr] = part.split(':');
      const params = paramStr !== undefined ? paramStr.split(',') : [];
      let msg = null;
      const empty = value === null || value === '';
      switch (rule) {
        case 'required':
          if (isEmpty(value)) msg = `${lbl} is required.`;
          break;
        case 'email':
          if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) msg = `${lbl} must be a valid email.`;
          break;
        case 'integer':
          if (!empty && !/^-?\d+$/.test(String(value))) msg = `${lbl} must be an integer.`;
          break;
        case 'numeric':
          if (!empty && Number.isNaN(Number(value))) msg = `${lbl} must be a number.`;
          break;
        case 'boolean':
          if (!empty && !['0', '1', 'true', 'false', true, false, 0, 1].includes(value)) msg = `${lbl} must be true or false.`;
          break;
        case 'array':
          if (!empty && !Array.isArray(value)) msg = `${lbl} must be an array.`;
          break;
        case 'min': {
          if (!empty) {
            const n = Number(params[0]);
            if (!Number.isNaN(Number(value)) && String(value).trim() !== '' && typeof value !== 'boolean' && !Array.isArray(value) && /^-?\d+(\.\d+)?$/.test(String(value))) {
              if (Number(value) < n) msg = `${lbl} must be at least ${params[0]}.`;
            } else if (String(value).length < n) {
              msg = `${lbl} must be at least ${params[0]}.`;
            }
          }
          break;
        }
        case 'max': {
          if (!empty) {
            const n = Number(params[0]);
            if (/^-?\d+(\.\d+)?$/.test(String(value))) {
              if (Number(value) > n) msg = `${lbl} must not exceed ${params[0]}.`;
            } else if (String(value).length > n) {
              msg = `${lbl} must not exceed ${params[0]}.`;
            }
          }
          break;
        }
        case 'in':
          if (!empty && !params.includes(String(value))) msg = `${lbl} must be one of: ${params.join(', ')}.`;
          break;
        case 'date':
          if (!empty && Number.isNaN(new Date(String(value)).getTime())) msg = `${lbl} must be a valid date.`;
          break;
        case 'min_length':
          if (value !== null && String(value).length < Number(params[0])) msg = `${lbl} must be at least ${params[0]} characters.`;
          break;
        case 'same':
          if (String(value) !== String(data[params[0]] !== undefined ? data[params[0]] : '')) msg = `${lbl} must match ${label(params[0])}.`;
          break;
        default:
          break;
      }
      if (msg) {
        errors[field] = errors[field] || [];
        errors[field].push(msg);
        break; // first failing rule per field wins
      }
    }
  }
  return {
    fails: Object.keys(errors).length > 0,
    errors,
    firstError: Object.keys(errors).length ? errors[Object.keys(errors)[0]][0] : 'Validation failed.'
  };
}

module.exports = { validate };
