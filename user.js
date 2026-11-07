(async () => {
  const response = await fetch('/api/me');
  if (!response.ok) return;
  const user = await response.json();
  document.body.dataset.role = user.role;
  document.querySelectorAll('.who').forEach(element => {
    element.textContent = `${user.name} · ${user.role === 'owner' ? 'Owner' : 'Barista'}`;
  });
})();
