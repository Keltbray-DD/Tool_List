document.addEventListener("DOMContentLoaded", async function () {
    document.getElementById("appInfo").textContent = `${appName} ${appVersion}`;
    const apiURL = 'https://prod-39.uksouth.logic.azure.com:443/workflows/5138e81c16704be39280610c3eaf12d1/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=USJmtlF0KWJy4nQ_Gz90Qk2YYChilyTFKEiOMhfOPNM';
  
    const container = document.getElementById('cards-container');
    const searchBar = document.getElementById('search-bar');
    let allTools = [];
  
    function renderCards(tools) {
      container.innerHTML = ''; // Clear existing cards
  
      tools.forEach(tool => {
        const card = document.createElement('div');
        card.classList.add('card');
  
        const cardContent = document.createElement('div');
        cardContent.classList.add('card-content');
  
        const title = document.createElement('div');
        title.classList.add('card-title');
        title.textContent = tool.name;
  
        const description = document.createElement('div');
        description.classList.add('card-description');
        description.textContent = tool.description;
  
        if (tool.version) {
          const version = document.createElement('div');
          version.classList.add('card-version');
          version.textContent = 'Version: ' + tool.version;
          cardContent.appendChild(version);
        }
  
        cardContent.appendChild(title);
        cardContent.appendChild(description);
        card.appendChild(cardContent);
  
        card.addEventListener('click', () => {
          window.open(tool.url, '_blank');
        });
  
        container.appendChild(card);
      });
    }
  
    fetch(apiURL)
      .then(response => {
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        return response.json();
      })
      .then(tools => {
        allTools = tools;
        renderCards(allTools);
      })
      .catch(error => {
        console.error('Error fetching tools:', error);
      });
  
    // Search function
    searchBar.addEventListener('input', () => {
      const query = searchBar.value.toLowerCase();
      const filteredTools = allTools.filter(tool =>
        tool.name.toLowerCase().includes(query) ||
        (tool.description && tool.description.toLowerCase().includes(query))
      );
      renderCards(filteredTools);
    });
  });
  