const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.textContent = '';
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      window.location.href = '/admin';
    } else {
      errorBox.textContent = data.error || 'Login failed';
    }
  } catch {
    errorBox.textContent = 'Network error — please try again.';
  }
});
