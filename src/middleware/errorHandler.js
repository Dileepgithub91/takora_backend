export function notFound(req, res, next) {
  const err = new Error(`Not found - ${req.originalUrl}`);
  res.status(404);
  next(err);
}

function duplicateMessage(err) {
  const fields = Object.keys(err.keyPattern || err.keyValue || {});
  const field = fields[0] || 'value';
  const labelMap = {
    email: 'Email ID',
    employeeId: 'Employee ID',
    ticketNo: 'Ticket number',
    name: 'Name'
  };
  const label = labelMap[field] || field;
  return `${label} already exists. Please use a different ${label.toLowerCase()}.`;
}

export function errorHandler(err, req, res, next) {
  let status = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  let message = err.message || 'Server error';

  if (err?.code === 11000) {
    status = 409;
    message = duplicateMessage(err);
  }

  if (err?.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map(e => e.message).join(', ');
  }

  if (err?.name === 'CastError') {
    status = 400;
    message = 'Invalid ID format.';
  }

  console.error(err);

  res.status(status).json({
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
  });
}
